#!/bin/sh
#
# Fecha uma versão do sistema Playzin: calcula a próxima versão, valida o build e o
# pacote, sobe a versão no package.json, faz o commit, cria a tag anotada com as
# novidades e publica. A tag dispara o GitHub Actions (.github/workflows/release.yml),
# que monta o pacote assinado e publica no GitHub Releases: daí em diante os consoles
# encontram a versão nova em Configurações → Atualização do sistema (e procuram
# sozinhos uma vez por dia).
#
# A fonte da verdade da versão é o "version" do package.json da raiz: a tela do
# console mostra ela (gravada no index.html pelo vite.config.ts do launcher), o
# daemon lê ela do pacote instalado e a atualização compara com ela. A tag vX.Y.Z
# marca o commit daquela versão e tem de bater com o package.json (o workflow confere).
#
# A mensagem da tag são as NOVIDADES QUE APARECEM NA TV antes de instalar: o script
# monta a partir dos commits (feat: → "Novidades", fix: → "Correções"; o resto fica
# de fora) e --edit abre um editor para escrever do seu jeito antes de publicar.
#
# Uso:
#   ./release.sh                      # mostra a versão atual e as opções
#   ./release.sh minor                # v0.3.0 -> v0.4.0
#   ./release.sh v1.0.0               # versão explícita
#   ./release.sh minor --edit         # ajusta as novidades no editor ($VISUAL/$EDITOR)
#   ./release.sh patch --dry-run      # ensaia sem criar nada (roda as verificações)
#   ./release.sh patch --skip-checks  # pula build e pacote de teste (evite)
#   ./release.sh patch --no-push      # cria commit e tag locais, não publica
#   ./release.sh patch --yes          # não pergunta antes de criar
#
# A chave privada (para o pacote de teste) vem de $PLAYZIN_RELEASE_KEY_FILE ou de
# ~/.playzin/release-signing-key.pem. No GitHub, ela é o segredo PLAYZIN_RELEASE_KEY.
set -e

cd "$(dirname "$0")"

BUMP=""
DRY_RUN=0
SKIP_CHECKS=0
PUSH=1
ASSUME_YES=0
EDIT=0

for arg in "$@"; do
  case "$arg" in
    major | minor | patch) BUMP="$arg" ;;
    v[0-9]*) BUMP="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --no-push) PUSH=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --edit) EDIT=1 ;;
    *)
      echo "Argumento desconhecido: $arg" >&2
      exit 1
      ;;
  esac
done

abortar() {
  echo "Erro: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || abortar "node não encontrado no PATH."
command -v npm >/dev/null 2>&1 || abortar "npm não encontrado no PATH."

# --- Versão atual -----------------------------------------------------------
# A do package.json da raiz (sem o "v"). A última tag vX.Y.Z (se houver) é o ponto
# de partida das novidades; sem tag nenhuma, entra o histórico inteiro.
ATUAL="v$(node -p "require('./package.json').version")"
ULTIMA_TAG=$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)

NUMEROS=${ATUAL#v}
MAJOR=$(echo "$NUMEROS" | cut -d. -f1)
MINOR=$(echo "$NUMEROS" | cut -d. -f2)
PATCH=$(echo "$NUMEROS" | cut -d. -f3)
[ -n "$MINOR" ] || MINOR=0
[ -n "$PATCH" ] || PATCH=0

proxima() {
  case "$1" in
    major) echo "v$((MAJOR + 1)).0.0" ;;
    minor) echo "v$MAJOR.$((MINOR + 1)).0" ;;
    patch) echo "v$MAJOR.$MINOR.$((PATCH + 1))" ;;
    *) echo "$1" ;;
  esac
}

if [ -n "$ULTIMA_TAG" ]; then
  INTERVALO="$ULTIMA_TAG..HEAD"
  COMMITS=$(git rev-list "$INTERVALO" --count)
  DESDE="desde $ULTIMA_TAG"
else
  INTERVALO="HEAD"
  COMMITS=$(git rev-list HEAD --count)
  DESDE="sem nenhuma tag ainda"
fi

if [ -z "$BUMP" ]; then
  echo "Versão atual do sistema: $ATUAL ($COMMITS commit(s) $DESDE)"
  echo
  echo "Uso: ./release.sh <major|minor|patch|vX.Y.Z> [--edit] [--dry-run] [--skip-checks] [--no-push] [--yes]"
  echo
  echo "  major -> $(proxima major)   (mudança grande: saves/perfis em formato novo, SDK que quebra cartuchos antigos)"
  echo "  minor -> $(proxima minor)   (novidade: tela, recurso do console, função nova no SDK)"
  echo "  patch -> $(proxima patch)   (correção ou ajuste)"
  if [ -z "$ULTIMA_TAG" ]; then
    echo
    echo "  Primeira versão? ./release.sh $ATUAL  marca a versão atual sem mudar o número."
  fi
  exit 0
fi

NOVA=$(proxima "$BUMP")
NOVA_NUM=${NOVA#v}

# --- Guardas ----------------------------------------------------------------
echo "$NOVA" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' ||
  abortar "versão '$NOVA' fora do padrão vX.Y.Z."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || abortar "você está em '$BRANCH'. Versão se fecha na main."

[ -z "$(git status --porcelain)" ] ||
  abortar "há alterações não commitadas. A versão apontaria para um commit que não contém o que você está vendo."

! git rev-parse -q --verify "refs/tags/$NOVA" >/dev/null ||
  abortar "a tag $NOVA já existe."

[ "$COMMITS" -gt 0 ] || abortar "nenhum commit novo $DESDE. Não há o que versionar."

# Só dá para "repetir" o número do package.json quando ele ainda não foi marcado
# (a primeira versão); depois, a versão tem de andar para a frente: um console só
# oferece uma versão MAIOR que a instalada.
MAIOR=$(printf '%s\n%s\n' "$NUMEROS" "$NOVA_NUM" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
[ "$MAIOR" = "$NOVA_NUM" ] || abortar "$NOVA é menor que a versão atual ($ATUAL)."
if [ "$NOVA" = "$ATUAL" ] && [ -n "$ULTIMA_TAG" ]; then
  abortar "$NOVA já é a versão do package.json e já há versões publicadas: os consoles não veriam nada novo. Use patch, minor ou major."
fi

# Sem o workflow no commit, a tag não publica nada (e os consoles não recebem a versão).
git cat-file -e "HEAD:.github/workflows/release.yml" 2>/dev/null ||
  abortar ".github/workflows/release.yml não está no último commit: a tag não publicaria a versão."

# --- Verificações -----------------------------------------------------------
# O build gera o que vai no pacote (daemon, launcher, shared); o typecheck pega erro de
# tipo em todos os pacotes. O pacote de teste monta o mesmo .tar.gz que o GitHub
# Actions vai montar e assina com a sua chave, conferindo com a chave pública que vai
# dentro dos consoles: chave trocada ou pacote quebrado aparecem aqui, não no console.
if [ "$SKIP_CHECKS" -eq 0 ]; then
  [ -d node_modules ] || abortar "node_modules ausente. Rode: npm ci"

  # O build vem antes do typecheck: os pacotes conferem os tipos contra o shared e o sdk
  # compilados (numa cópia nova do projeto eles ainda não existem). Mesma ordem do workflow.
  echo "==> Build"
  npm run build >/dev/null 2>&1 || abortar "o build falhou (rode npm run build para ver)."

  echo "==> Typecheck"
  npm run typecheck >/dev/null 2>&1 || abortar "o typecheck falhou (rode npm run typecheck para ver)."

  CHAVE="${PLAYZIN_RELEASE_KEY_FILE:-$HOME/.playzin/release-signing-key.pem}"
  if [ -f "$CHAVE" ]; then
    echo "==> Pacote de teste (conteúdo e assinatura)"
    TESTE=$(mktemp -d)
    if ! node scripts/release/build-release.mjs --out "$TESTE/pacote" --base-url "https://example.invalid" --key "$CHAVE" >"$TESTE/log" 2>&1; then
      cat "$TESTE/log" >&2
      rm -rf "$TESTE"
      abortar "o pacote de teste não fechou (veja acima)."
    fi
    tail -1 "$TESTE/log"
    rm -rf "$TESTE"
  else
    echo "Aviso: chave $CHAVE não encontrada; o pacote só vai ser montado (e assinado) no GitHub Actions."
  fi

  echo "Verificações ok."
else
  echo "Verificações puladas (--skip-checks)."
fi

# --- Novidades (vão na tag e aparecem na TV) --------------------------------
# Dos commits do intervalo, sem os de merge e sem os "chore: versão" deste script.
ASSUNTOS=$(git log --no-merges --pretty=format:'%s' $INTERVALO | grep -v '^chore: versão v' || true)
item() {
  # "feat(launcher): página do jogo" -> "- Página do jogo"
  sed -E 's/^[a-z]+(\([^)]*\))?!?: *//' | awk 'NF { print "- " toupper(substr($0, 1, 1)) substr($0, 2) }'
}
NOVIDADES=$(echo "$ASSUNTOS" | grep -E '^feat(\([^)]*\))?!?:' | item || true)
CORRECOES=$(echo "$ASSUNTOS" | grep -E '^fix(\([^)]*\))?!?:' | item || true)

NOTAS_ARQ=$(mktemp)
trap 'rm -f "$NOTAS_ARQ"' EXIT
{
  if [ -n "$NOVIDADES" ]; then
    echo "Novidades:"
    echo "$NOVIDADES"
  fi
  if [ -n "$CORRECOES" ]; then
    [ -z "$NOVIDADES" ] || echo
    echo "Correções:"
    echo "$CORRECOES"
  fi
  # Sem feat/fix (só ajustes internos): um texto genérico em vez de uma lista vazia.
  if [ -z "$NOVIDADES" ] && [ -z "$CORRECOES" ]; then
    echo "Melhorias e ajustes internos."
  fi
} >"$NOTAS_ARQ"

if [ "$EDIT" -eq 1 ]; then
  EDITOR_CMD="${VISUAL:-${EDITOR:-vi}}"
  {
    echo
    echo "# Novidades da $NOVA: este texto aparece na TV antes de instalar."
    echo "# Linhas começando com # são ignoradas. Arquivo vazio cancela."
  } >>"$NOTAS_ARQ"
  $EDITOR_CMD "$NOTAS_ARQ" || abortar "o editor ($EDITOR_CMD) saiu com erro."
  LIMPO=$(grep -v '^#' "$NOTAS_ARQ" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
  printf '%s\n' "$LIMPO" >"$NOTAS_ARQ"
  [ -n "$(tr -d '[:space:]' <"$NOTAS_ARQ")" ] || abortar "novidades vazias: cancelado."
fi

echo
echo "$ATUAL -> $NOVA"
echo
echo "Novidades que vão aparecer na TV:"
sed 's/^/  │ /' "$NOTAS_ARQ"
echo

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(--dry-run: nada foi criado nem publicado)"
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  if [ -t 0 ]; then
    if [ "$PUSH" -eq 1 ]; then
      printf "Criar e publicar a versão %s? Os consoles vão encontrar a atualização. [s/N] " "$NOVA"
    else
      printf "Criar a versão %s (sem publicar)? [s/N] " "$NOVA"
    fi
    read -r RESPOSTA
    case "$RESPOSTA" in
      s | S | sim | y | Y) ;;
      *)
        echo "Cancelado."
        exit 0
        ;;
    esac
  else
    abortar "sem terminal para confirmar. Use --yes para rodar sem interação."
  fi
fi

# --- Versão nos arquivos ----------------------------------------------------
# Só o package.json da raiz (e o package-lock.json): é a versão do sistema. Os
# package.json dos pacotes internos (daemon, launcher, sdk...) não mudam.
if [ "$NOVA" != "$ATUAL" ]; then
  npm version "$NOVA_NUM" --no-git-tag-version --no-workspaces-update >/dev/null
  git add package.json package-lock.json
  git commit -q -m "chore: versão $NOVA"
  echo "Versão $NOVA gravada no package.json (commit $(git rev-parse --short HEAD))."
fi

# --- Tag --------------------------------------------------------------------
# Anotada, e não leve: guarda autor, data e as novidades no próprio objeto. O
# workflow usa a mensagem da tag como as novidades do GitHub Releases e da TV.
git tag -a "$NOVA" -F "$NOTAS_ARQ"
echo "Tag $NOVA criada."

# Endereço do repositório no GitHub (para os links do fim).
REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##')

if [ "$PUSH" -eq 1 ]; then
  git push origin main "$NOVA"
  echo "Versão publicada."
  echo
  echo "O GitHub Actions agora monta, assina e publica o pacote (uns 2 minutos):"
  echo "  $REPO/actions"
  echo "  $REPO/releases/tag/$NOVA"
  echo
  echo "Depois, no console: Configurações → Atualização do sistema → Procurar atualização"
  echo "(ou espere: ele procura sozinho uma vez por dia)."
  echo
  echo "Se o Actions falhar em \"Pacote assinado\": confira o segredo PLAYZIN_RELEASE_KEY em"
  echo "  $REPO/settings/secrets/actions"
else
  echo "Não publicada (--no-push). Para publicar: git push origin main $NOVA"
fi
