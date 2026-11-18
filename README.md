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

- **Fileira de jogos:** o cartucho inserido aparece primeiro; os jogos que já passaram pelo
  console ficam logo depois, esmaecidos, pedindo para inserir o cartucho.
- **Ícones de sistema:** Controles (lista os controles conectados), Dados salvos (progresso de cada
  jogo, com opção de apagar) e Configurações (versão, status).
- Navegue com direcional/setas, mouse (clique seleciona, segundo clique abre) ou controle.

| Ação | Teclado | Controle |
|---|---|---|
| Navegar | setas / WASD | direcional ou analógico |
| Jogar / OK | Enter / Espaço | A |
| Voltar / fechar painel | Backspace | B |
| Remover jogo da lista | L | X |
| Voltar ao menu (durante o jogo) | segurar Esc por 1 s | botão Xbox, ou View + Menu por 1 s |

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
import { PlayerInput, createSaveStore, ready, exitToMenu, isInsidePlayzin } from 'playzin/sdk';

const controls = new PlayerInput({ player: 0 });   // teclado + 1º controle
const saves = createSaveStore('chapelao');

// no update() da cena:
controls.update();
if (controls.justPressed('confirm')) pular();
const { x } = controls.getMove();                   // -1..1, analógico ou direcional

saves.set('fase', 3);
ready();                                            // terminou de carregar (tira o "Carregando…")
if (isInsidePlayzin()) mostrarOpcao('VOLTAR AO CONSOLE', exitToMenu);
```

Ações: `up`, `down`, `left`, `right`, `confirm` (A), `back` (B), `action` (X), `special` (Y), `pause` (Menu).
Fora do console, `ready()` e `exitToMenu()` não fazem nada: o jogo continua rodando normalmente no navegador.
O `mozin-e-mozinzin-the-game` é um exemplo completo de jogo integrado.

## Saves: o progresso fica no console

Os jogos continuam usando `localStorage` (ou o `createSaveStore` do SDK) normalmente, sem
mudar nada. Por baixo, o console:

- **guarda o progresso em disco**, um arquivo por jogo: `.playzin-data/saves/<id>.json` no
  computador, `/var/lib/playzin/saves/` no Pi. Gravação atômica, com a versão anterior em `.bak`;
- **isola os jogos:** ao abrir um cartucho, o `localStorage` recebe só os dados daquele jogo,
  e um `localStorage.clear()` dentro do jogo apaga só os dados dele;
- **grava enquanto você joga** (alguns décimos de segundo depois de cada mudança) e mais uma vez
  ao sair do jogo, inclusive quando o cartucho é puxado;
- **aproveita o progresso antigo:** o que já estava no navegador antes desta versão é copiado uma
  vez, e cada jogo leva para o save dele só as chaves que usar.

Em **Dados salvos**, na tela inicial, dá para ver e apagar o progresso de cada jogo (X duas vezes).
Apagar faz o jogo começar do zero na próxima vez.

Só `localStorage` é coberto: dados em IndexedDB ou cookies continuam apenas no navegador.

## Instalando no Raspberry Pi

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

**Controle de Xbox via Bluetooth:** pareie uma vez pelo terminal do Pi (`bluetoothctl` →
`scan on` → `pair <MAC>` → `trust <MAC>` → `connect <MAC>`). Para o mapeamento e a vibração
corretos, instale o driver [xpadneo](https://github.com/atar-axis/xpadneo).

**Somente leitura (opcional, no fim):** `sudo raspi-config` → Performance Options →
Overlay File System. Faça isso **depois** de parear os controles: com o overlay ligado,
nada do que muda no sistema sobrevive a um reboot, **e isso inclui os saves dos jogos**
(`/var/lib/playzin`). Por enquanto, prefira não ligar o overlay e desligar o console pelo
botão. Uma partição separada só para os saves está nos próximos passos.

## Configuração do daemon (variáveis de ambiente)

| Variável | Padrão | Para quê |
|---|---|---|
| `PLAYZIN_PORT` | `7777` | Porta do servidor |
| `PLAYZIN_HOST` | `127.0.0.1` | Interface (só local, de propósito) |
| `PLAYZIN_SOURCE` | `auto` | `dir` (pastas), `udisks` (D-Bus, Pi) ou `auto` |
| `PLAYZIN_SLOT_DIRS` | `dev-slot` (+ `/Volumes` no Mac) | Pastas observadas, separadas por vírgula |
| `PLAYZIN_DRIVE_ROOTS` | no Windows: `D:\` a `Z:\` (menos a do sistema) | Pastas que são, elas mesmas, um cartucho |
| `PLAYZIN_POLL_MS` | `1000` | Intervalo de verificação das pastas |
| `PLAYZIN_SAVES_DIR` | `.playzin-data/saves` (Pi: `/var/lib/playzin/saves`) | Onde ficam os saves dos jogos |

## Status

- [x] Daemon: detecção por pastas (dev, Mac `/Volumes`) e por UDisks2 (Pi), validação do manifesto, servidor de arquivos protegido, WebSocket
- [x] Tela inicial estilo console: fileira de jogos com histórico, ícones de sistema, painéis, sons, mouse/teclado/controle
- [x] SDK: input unificado teclado/controle, saves por jogo, `ready()` / `exitToMenu()`
- [x] Scripts de instalação do Pi (systemd + cage + Chromium + polkit)
- [x] Comando `playzin` (init, build, check, insert, eject, pack) e SDK em `playzin/sdk`
- [ ] Tela de pareamento Bluetooth no próprio launcher
- [x] Saves guardados pelo console, isolados por jogo, com a tela Dados salvos
- [ ] Partição só para os saves no Pi (para poder ligar o sistema somente leitura)
- [ ] Backup dos saves num pendrive
- [ ] Testar a fonte UDisks2 e o kiosk no hardware real
