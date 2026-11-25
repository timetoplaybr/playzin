# Playzin

Um console caseiro: um Raspberry Pi ligado na TV que roda jogos HTML/JS a partir de
**cartuchos** (pendrives). Plugou o cartucho, o jogo aparece. Tirou, volta para o menu.

```
[pendrive] → daemon (Node/TS) ── WebSocket ──→ launcher (Phaser) ──→ jogo num iframe
               ├─ detecta e monta o cartucho
               ├─ valida o playzin.json
               └─ serve os arquivos em http://127.0.0.1:7777/cart/...
```

## Estrutura

| Pasta | O que é |
|---|---|
| `packages/shared` | Tipos e contratos comuns (manifesto, mensagens do WebSocket) |
| `packages/daemon` | O "kernel": servidor Fastify, WebSocket e detecção de cartuchos |
| `packages/launcher` | A tela inicial do console (HTML/CSS/TS): fileira de jogos, ícones de sistema, sons |
| `packages/sdk` | Lib que os jogos importam: input unificado, saves, `ready()`, `exitToMenu()` |
| `packages/cli` | Pacote **`playzin`**: o comando que prepara/valida/grava cartuchos + o SDK (`playzin/sdk`) |
| `cartridges/hello-playzin` | Cartucho de exemplo |
| `scripts/pi` | Setup do Raspberry Pi (systemd, cage, Chromium, polkit) |
| `dev-slot/` | "Slot de cartucho" de mentira para desenvolver sem pendrive |

## Rodando no computador

Requer Node 20+.

```bash
npm install
npm start               # compila tudo e sobe o daemon
```

Abra **http://127.0.0.1:7777** e, em outro terminal:

```bash
npm run cart:insert     # "insere" o cartucho de exemplo (copia para dev-slot/)
npm run cart:eject      # remove todos os cartuchos do dev-slot
```

**Com um pendrive de verdade:** no Mac, o daemon observa `/Volumes`; no Windows, a raiz de cada
unidade (D:, E:, F:… menos a do sistema). Copie o cartucho
para a raiz do pendrive e plugue:

```bash
npm run cart:pack -- /Volumes/NOME_DO_PENDRIVE   # cartucho de exemplo
```

Para os seus jogos, use o comando `playzin` dentro da pasta de cada um (próxima seção).

### A tela inicial

Ao ligar, o console mostra uma abertura de uns 3 segundos: um cartucho encaixa na fenda, o nome
Playzin aparece letra por letra e toca um acorde. Qualquer botão, tecla ou clique pula a abertura.

- **Fileira de jogos:** o cartucho inserido aparece primeiro; os jogos que já passaram pelo
  console ficam logo depois, esmaecidos, pedindo para inserir o cartucho.
- **Perfil:** o avatar no canto superior esquerdo mostra quem está jogando; suba até ele (ou clique)
  para trocar de perfil. Veja [Perfis](#perfis-até-4-pessoas-por-console).
- **Ícones de sistema:** Controles (pareamento Bluetooth), Wi-Fi (escolher a rede), Atividade (tempo
  de jogo do perfil, jogo a jogo, e quanto cada perfil jogou de cada um), Dados salvos (progresso de cada
  jogo, com opção de apagar), Configurações (versão, status), Tela cheia (também pela tecla **F**)
  e Desligar (veja [Desligar e reiniciar](#desligar-e-reiniciar)).
  O botão de tela cheia some quando o navegador já ocupa a tela toda (modo quiosque do Pi, F11).
  No Chrome/Edge, em tela cheia o Esc continua indo para o jogo; para sair, segure Esc ou use o botão.
- Navegue com direcional/setas, mouse (clique seleciona, segundo clique abre) ou controle.

### O menu rápido

Durante o jogo, o botão Xbox/PS (ou View + Menu, ou Esc segurados por 1 s) abre um menu por
cima do jogo, com o nome e a capa do jogo, quem está jogando, há quanto tempo e quantos
controles estão ligados:

- **Continuar:** volta para o jogo (também com B, Esc ou o botão Xbox de novo);
- **Reiniciar jogo:** grava os saves e recarrega o jogo do começo (A duas vezes);
- **Sair do jogo:** volta para a tela inicial (A duas vezes).

Enquanto o menu está aberto, o jogo fica pausado: jogos com o SDK recebem um aviso de pausa e
o `PlayerInput` não enxerga os botões usados no menu. Nos jogos sem o SDK, o console pausa os
`<audio>`/`<video>` da página e tira o teclado do jogo, mas o jogo em si continua rodando.

| Ação | Teclado | Controle |
|---|---|---|
| Navegar | setas / WASD | direcional ou analógico |
| Jogar / OK | Enter / Espaço | A |
| Voltar / fechar painel | Backspace | B |
| Remover jogo da lista / editar perfil | L | X |
| Menu rápido (durante o jogo) | segurar Esc por 1 s | botão Xbox/PS, ou View + Menu por 1 s |

### Desenvolvendo o launcher com hot reload

```bash
npm run dev:daemon      # terminal 1 (porta 7777)
npm run dev:launcher    # terminal 2 → http://localhost:5173 (repassa /ws, /api e /cart ao daemon)
```

## Criando um cartucho

Um cartucho é o **build do jogo** com um `playzin.json` na raiz (e, de preferência, uma capa).
O pacote `playzin` (em `packages/cli`) cuida de tudo isso para qualquer jogo.

### 1. Instalar no jogo (uma vez)

Com o jogo numa pasta **ao lado** do Playzin (`.../playzin/` e `.../meu-jogo/`) e o Playzin já
compilado (`npm install && npm run build` aqui):

```bash
cd ../meu-jogo
npm install -D ../playzin/packages/cli
npx playzin init --players 1-2
```

O `init` cria `public/playzin.json` (id, nome a partir do `<title>`, versão do `package.json`),
adiciona os scripts `cartucho` e `cartucho:pendrive` e avisa se falta `base: './'` no Vite.
Como a instalação é um link para esta pasta, melhorias no Playzin chegam ao jogo sem reinstalar.

### 2. Usar

```bash
npm run cartucho                                 # compila, confere e insere no console de desenvolvimento
npm run cartucho:pendrive -- /Volumes/PENDRIVE   # compila, confere, limpa o pendrive e grava (Windows: E:\)
npx playzin check                                # só confere o último build
npx playzin eject                                # tira o jogo do console de desenvolvimento
npx playzin help
```

A cada build, o comando:
- copia a versão do `package.json` para o `playzin.json` (a do `package.json` vale);
- confere o manifesto, o arquivo de entrada e a capa (quadrada, até 400 KB);
- recusa caminhos absolutos no HTML (o jogo roda em `/cart/<slot>/`, então no Vite use `base: './'`);
- avisa se o jogo carrega coisas da internet (o console pode estar sem rede).

No `pack`, o pendrive é limpo antes de gravar, mas só se estiver vazio ou já for um cartucho
Playzin. Com outros arquivos, o comando para e lista o que encontrou (use `--force` para apagar
mesmo assim). Pastas de projeto, a pasta pessoal e a unidade do sistema nunca são aceitas.

### O playzin.json

```json
{
  "id": "chapelao",
  "name": "Chapelão the Game",
  "version": "1.0.0",
  "entry": "index.html",
  "cover": "cover.png",
  "players": [1, 2]
}
```

- `id`: minúsculas, números, `.`, `-` ou `_`. Identifica o jogo na lista do console.
- `entry` (padrão `index.html`) e `cover` são caminhos relativos à raiz do cartucho.
- A capa aparece num bloco **quadrado**: use **512×512** (PNG ou JPG, até 400 KB) em `public/cover.png`.
  Sem capa, o console gera uma com as iniciais do jogo.

### SDK (opcional, recomendado)

```ts
import { PlayerInput, createSaveStore, ready, exitToMenu, isInsidePlayzin, onLauncherMessage } from 'playzin/sdk';

const controls = new PlayerInput({ player: 0 });   // teclado + 1º controle
const saves = createSaveStore('chapelao');

// no update() da cena:
controls.update();
if (controls.justPressed('confirm')) pular();
const { x } = controls.getMove();                   // -1..1, analógico ou direcional

saves.set('fase', 3);
ready();                                            // terminou de carregar (tira o "Carregando…")
if (isInsidePlayzin()) mostrarOpcao('VOLTAR AO CONSOLE', exitToMenu);

// menu rápido do console aberto/fechado: pare relógios, música, inimigos...
onLauncherMessage((tipo) => (tipo === 'pause' ? pausarJogo() : retomarJogo()));
```

Ações: `up`, `down`, `left`, `right`, `confirm` (A), `back` (B), `action` (X), `special` (Y), `pause` (Menu).
Fora do console, `ready()` e `exitToMenu()` não fazem nada: o jogo continua rodando normalmente no navegador.
Com o menu rápido aberto, o `PlayerInput` não registra nada (e o botão usado para fechar o menu não
vaza para o jogo); `isPausedByLauncher()` diz se o menu está aberto agora.
O `mozin-e-mozinzin-the-game` é um exemplo completo de jogo integrado.

## Controles Bluetooth

O pareamento é feito pela tela do console, sem terminal: **Controles → Adicionar controle**.

1. Coloque o controle em modo de pareamento (a tela mostra como no Xbox, DualSense e DualShock 4).
2. Ele aparece em "Encontrados"; escolha e aperte **A**.
3. O console pareia, marca como confiável e conecta. Daí em diante, basta ligar o controle.

Em Controles também dá para **esquecer** um controle (X duas vezes). A lista mostra só controles,
teclados e mouses (fones e caixas de som ficam de fora).

**O primeiro controle:** para navegar até "Adicionar controle" é preciso algum controle. Se o
console ligar sem nenhum controle pareado, ele entra em **pareamento automático** por 5 minutos:
coloque o controle em modo de pareamento e ele é conectado sozinho (o rodapé avisa quando isso
está ativo). Um controle com cabo USB ou um teclado USB também funcionam na hora.

**No computador** não existe o Bluetooth do console (é o BlueZ, do Linux). Para usar e testar
a tela no Mac/Windows há um **Bluetooth simulado**, com controles de mentira (veja "Testando no
PC com Bluetooth e Wi-Fi simulados" abaixo). O 8BitDo simulado falha na primeira tentativa de
propósito, para mostrar a mensagem de erro.

## Wi-Fi

Em **Wi-Fi**, na tela inicial: a rede atual (com o IP) e as redes por perto, com a força do
sinal e um cadeado nas protegidas. Escolha uma rede e aperte **A**; se ela pedir senha, abre o
**teclado virtual**. A rede fica salva, e da próxima vez o console conecta sem pedir senha.
**X** duas vezes esquece uma rede salva e **Y** procura de novo. Senha errada? O console avisa e
abre o teclado de novo.

O teclado virtual funciona com o controle: direcional escolhe a tecla, **A** digita,
**B** apaga (com o campo vazio, cancela), **X** liga as maiúsculas, **Y** mostra/oculta a senha e
**Menu (☰)** confirma. A tecla **?123** troca para números e símbolos. Um teclado de verdade
(USB ou Bluetooth) também funciona: é só digitar.

A rede configurada no Raspberry Pi Imager, na gravação do cartão SD, já aparece como salva.
Os jogos não precisam de internet; ela serve para acertar o relógio (o Pi 4 não guarda a hora
desligado) e para atualizações.

## Desligar e reiniciar

O último ícone da tela inicial, **Desligar**, abre duas opções: **Desligar o console** e
**Reiniciar o console**. A tela mostra "Desligando…" e, um instante depois, o sistema desliga de
verdade: a TV fica sem sinal e aí pode tirar da tomada. Desligar por aqui evita estragar o
cartão de memória. Os saves já estão gravados (o console grava enquanto você joga).

No Pi, o daemon desliga pelo systemd-logind (D-Bus), com a permissão dada pelo polkit em
`scripts/pi/files/50-playzin-power.rules` (instalada pelo `setup.sh`). Se algo der errado
(falta de permissão, sistema sem responder), a tela volta para o menu com o aviso do erro.

**No computador** o desligamento é **simulado**: a tela "apaga" e qualquer botão "liga" de novo
(Reiniciar recarrega o launcher). O daemon só desliga de verdade quando roda como serviço do
systemd (o console) ou com `PLAYZIN_POWER=logind`.

## Testando no PC com Bluetooth e Wi-Fi simulados

No computador, as telas de Controles e Wi-Fi não mexem no Bluetooth nem no Wi-Fi de verdade.
Para usá-las e testá-las, há versões simuladas:

```bash
npm run start:simulado
```

- Bluetooth: quatro aparelhos aparecem na busca; o 8BitDo falha na primeira tentativa.
- Wi-Fi: começa conectado em "Casa do Diego"; a senha das redes protegidas é `playzin123`
  (qualquer outra dá "senha incorreta"); "Cafeteria Livre" é aberta.

## Perfis: até 4 pessoas por console

Cada pessoa da casa tem o seu perfil, com **nome, ícone e cor**. Os jogos salvos são separados
por perfil; Wi-Fi, controles pareados e a lista de jogos da tela inicial valem para o console todo.

- **Primeira vez:** o console pede para criar um perfil antes de jogar (nome pelo teclado virtual,
  ícone e cor com ← e →).
- **Ao ligar:** com um perfil só, ele entra direto. Com mais de um, aparece **Quem vai jogar?**,
  com o foco em quem jogou por último.
- **Trocar, criar, editar ou excluir:** pelo avatar no topo da tela inicial. Em *Quem vai jogar?*:
  A escolhe, X edita e o último cartão cria um perfil novo (enquanto houver menos de 4).
  Excluir pede confirmação (A duas vezes) e **apaga os jogos salvos daquele perfil**.
- **Quem já usava o console antes dos perfis:** os saves existentes passam para o primeiro perfil
  criado. Os perfis seguintes começam do zero em todos os jogos.

**Tema:** a cor de destaque do menu (foco, barras, botões, teclado virtual) é a cor do perfil
ativo. Em *Quem vai jogar?* o menu já mostra a cor de quem está em foco, e no editor dá para ver a
cor nova antes de salvar.

**Tempo de jogo:** o console conta quanto cada perfil jogou de cada jogo. Aparece ao lado do nome
do jogo na tela inicial, em *Dados salvos*, em *Configurações* (total) e em *Quem vai jogar?*.
A tela **Atividade** lista os jogos do perfil do mais jogado para o menos jogado, com tempo,
quantas vezes abriu e quando jogou por último; A num jogo mostra quanto cada perfil jogou dele.
Só conta o tempo jogando de verdade: para com a janela escondida e depois de 10 minutos sem
ninguém mexer em controle, teclado ou mouse. O launcher envia o tempo a cada 30 s, então desligar
na tomada perde no máximo isso.

Os perfis ficam em `.playzin-data/profiles.json` no computador e em `/var/lib/playzin/profiles.json`
no Pi; os saves, em uma pasta por perfil (`saves/<perfil>/<jogo>.json`, com o tempo de jogo em
`saves/<perfil>/_playtime.json`). Os jogos não precisam
saber de nada: o console entrega a cada um só o progresso do perfil que está jogando.

## Saves: o progresso fica no console

Os jogos continuam usando `localStorage` (ou o `createSaveStore` do SDK) normalmente, sem
mudar nada. Por baixo, o console:

- **guarda o progresso em disco**, um arquivo por jogo em cada perfil: `.playzin-data/saves/<perfil>/<id>.json`
  no computador, `/var/lib/playzin/saves/` no Pi. Gravação atômica, com a versão anterior em `.bak`;
- **isola os jogos:** ao abrir um cartucho, o `localStorage` recebe só os dados daquele jogo,
  e um `localStorage.clear()` dentro do jogo apaga só os dados dele;
- **grava enquanto você joga** (alguns décimos de segundo depois de cada mudança) e mais uma vez
  ao sair do jogo, inclusive quando o cartucho é puxado;
- **aproveita o progresso antigo:** o que já estava no navegador antes desta versão é copiado uma
  vez, e cada jogo leva para o save dele só as chaves que usar (só no primeiro perfil).

Em **Dados salvos**, na tela inicial, dá para ver e apagar o progresso de cada jogo do perfil
ativo (X duas vezes).
Apagar faz o jogo começar do zero na próxima vez.

Só `localStorage` é coberto: dados em IndexedDB ou cookies continuam apenas no navegador.

## Instalando no Raspberry Pi

Guia completo, passo a passo a partir do Windows: [docs/raspberry-pi.md](docs/raspberry-pi.md).

1. Grave o **Raspberry Pi OS Lite (64-bit)** no cartão SD (Raspberry Pi Imager; já configure
   Wi-Fi, usuário e SSH por lá).
2. Copie este projeto para o Pi (ex.: `scp -r playzin pi@raspberrypi.local:~`) ou clone do git.
3. No Pi:
   ```bash
   cd ~/playzin
   sudo ./scripts/pi/setup.sh
   sudo reboot
   ```

Depois do reboot, o Pi abre direto o menu na TV. Grave um cartucho num pendrive com
`npm run cartucho:pendrive -- /caminho/do/pendrive` (na pasta do jogo) e plugue.

Logs: `journalctl -u playzin-daemon -f` e `journalctl -u playzin-kiosk -f`.

**Controles Bluetooth:** veja a seção "Controles Bluetooth" acima: o pareamento é feito pela
própria tela do console. O `setup.sh` também instala o driver
[xpadneo](https://github.com/atar-axis/xpadneo), que acerta o mapeamento dos botões e a vibração
dos controles de Xbox por Bluetooth (ele não interfere em outros controles). Ele é baixado do
GitHub e compilado no Pi, então a instalação precisa de internet e leva alguns minutos a mais.
Se a compilação falhar, o setup avisa e segue: o controle de Xbox só fica com o driver genérico.
Para pular: `sudo ./scripts/pi/setup.sh --sem-xpadneo`.

**Somente leitura (opcional, no fim):** `sudo raspi-config` → Performance Options →
Overlay File System. Faça isso **depois** de parear os controles: com o overlay ligado,
nada do que muda no sistema sobrevive a um reboot, **e isso inclui os saves dos jogos**
(`/var/lib/playzin`). Por enquanto, prefira não ligar o overlay e desligar o console pelo
ícone **Desligar** da tela inicial. Uma partição separada só para os saves está nos próximos passos.

## Configuração do daemon (variáveis de ambiente)

| Variável | Padrão | Para quê |
|---|---|---|
| `PLAYZIN_PORT` | `7777` | Porta do servidor |
| `PLAYZIN_HOST` | `127.0.0.1` | Interface (só local, de propósito) |
| `PLAYZIN_SOURCE` | `auto` | `dir` (pastas), `udisks` (D-Bus, Pi) ou `auto` |
| `PLAYZIN_SLOT_DIRS` | `dev-slot` (+ `/Volumes` no Mac) | Pastas observadas, separadas por vírgula |
| `PLAYZIN_DRIVE_ROOTS` | no Windows: `D:\` a `Z:\` (menos a do sistema) | Pastas que são, elas mesmas, um cartucho |
| `PLAYZIN_POLL_MS` | `1000` | Intervalo de verificação das pastas |
| `PLAYZIN_BLUETOOTH` | `auto` | `auto` (BlueZ se houver), `bluez`, `mock` (simulado) ou `none`. Também `--bluetooth=mock` |
| `PLAYZIN_BT_AUTOPAIR` | ligado no Pi | Pareamento automático ao ligar sem controle pareado (`0` desliga). Também `--autopair` |
| `PLAYZIN_WIFI` | `auto` | `auto` (NetworkManager se houver), `networkmanager`, `mock` (simulado) ou `none`. Também `--wifi=mock` |
| `PLAYZIN_POWER` | `auto` (Pi: `logind`) | Desligar/reiniciar pela tela: `auto` (logind só rodando como serviço do systemd; senão simulado), `logind`, `mock` ou `none`. Também `--power=mock` |
| `PLAYZIN_SAVES_DIR` | `.playzin-data/saves` (Pi: `/var/lib/playzin/saves`) | Onde ficam os saves dos jogos |
| `PLAYZIN_PROFILES_FILE` | `profiles.json` ao lado da pasta de saves | Lista de perfis do console |

## Status

- [x] Daemon: detecção por pastas (dev, Mac `/Volumes`) e por UDisks2 (Pi), validação do manifesto, servidor de arquivos protegido, WebSocket
- [x] Tela inicial estilo console: fileira de jogos com histórico, ícones de sistema, painéis, sons, mouse/teclado/controle
- [x] SDK: input unificado teclado/controle, saves por jogo, `ready()` / `exitToMenu()`
- [x] Menu rápido durante o jogo (continuar, reiniciar, sair), com pausa avisada ao jogo
- [x] Desligar e reiniciar pela tela (logind no Pi, simulado no PC)
- [ ] Testar o desligar/reiniciar de verdade (logind + polkit) no Raspberry Pi
- [x] Scripts de instalação do Pi (systemd + cage + Chromium + polkit)
- [x] Comando `playzin` (init, build, check, insert, eject, pack) e SDK em `playzin/sdk`
- [x] Pareamento Bluetooth pela tela do console (com pareamento automático e Bluetooth simulado)
- [x] Escolha do Wi-Fi pela tela do console, com teclado virtual
- [ ] Testar o Bluetooth de verdade (BlueZ) no Raspberry Pi
- [ ] Testar o Wi-Fi de verdade (NetworkManager) no Raspberry Pi
- [x] Saves guardados pelo console, isolados por jogo, com a tela Dados salvos
- [x] Perfis (até 4, com nome, ícone e cor), saves separados por perfil
- [x] Tempo de jogo por perfil e por jogo
- [ ] Partição só para os saves no Pi (para poder ligar o sistema somente leitura)
- [ ] Backup dos saves num pendrive
- [ ] Testar a fonte UDisks2 e o kiosk no hardware real
