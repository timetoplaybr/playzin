import type { CartridgeInfo } from '@playzin/shared';
import { DaemonConnection } from './connection';
import { GameFrame } from './game-frame';
import { Library } from './library';
import { ConsoleStore } from './store';
import { HomeUI, STAGE_HEIGHT, STAGE_WIDTH } from './ui/home';
import { LowBatteryWatcher } from './ui/battery';
import { GameToast } from './ui/game-toast';
import { Screensaver } from './ui/screensaver';
import { Sounds } from './ui/sounds';
import { getPlayerGamepads } from '@playzin/sdk';
import { installRemap } from './ui/remap';
import { onPhoneRumble, phoneInput, phonePadIndex, setPhonePads } from './ui/phone-pads';
import { restoreTheme } from './ui/theme';
import './style.css';

// Botões remapeados em Controles: antes de qualquer leitura de controle (menus, SDK, jogos).
installRemap();

// Cor do menu de quem jogou por último, já na abertura (troca suave quando o perfil entra).
restoreTheme();

const store = new ConsoleStore();
const connection = new DaemonConnection();
const library = new Library();
const sounds = new Sounds();
const stage = document.getElementById('home') as HTMLElement;

// ---- Palco fixo de 1280x720, escalado para caber em qualquer TV/monitor ----
function fitStage(): void {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  // A tela inicial e o menu rápido (por cima do jogo) usam o mesmo palco de 1280x720.
  for (const el of document.querySelectorAll<HTMLElement>('#home, .qm-stage')) {
    el.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }
}
window.addEventListener('resize', fitStage);
fitStage();

// ---- Avisos por cima do jogo (bateria fraca, conquistas) ----
const gameToast = new GameToast();

// ---- Jogo do cartucho (iframe) ----
const frame = new GameFrame(() => {
  // Voltou do jogo pelo atalho ou pelo SDK: o cartucho continua inserido.
  home.setActive(true);
  void frame.lastPlaytimeSaved.then(() => home.refreshPlaytime());
  sounds.back();
  const { cartridge } = store.get();
  store.update({ status: cartridge ? 'ready' : 'empty' });
}, sounds, gameToast);
fitStage(); // o menu rápido e o aviso por cima do jogo acabaram de entrar na página

function play(cartridge: CartridgeInfo): void {
  if (frame.isOpen) return;
  library.markPlayed(cartridge.manifest.id);
  const profile = store.profile();
  if (!profile) return home.openProfiles();
  store.update({ status: 'playing' });
  home.setActive(false);
  frame.open(cartridge, profile);
}

function stopPlaying(): void {
  if (!frame.isOpen) return;
  frame.close();
  home.setActive(true);
  void frame.lastPlaytimeSaved.then(() => home.refreshPlaytime());
}

// ---- Protetor de tela: no menu e por cima do jogo (que fica pausado enquanto isso) ----
const screensaver = new Screensaver({
  isPlaying: () => frame.isOpen,
  onStart: () => frame.suspend(),
  onEnd: () => frame.unsuspend(),
});
frame.onGameWindow = (win) => screensaver.watchGame(win);
frame.inputBlocked = () => screensaver.blocksInput;

const home = new HomeUI(stage, store, library, sounds, { play, screensaver });

// ---- Celular como controle ----
onPhoneRumble((id, ms) => connection.send({ type: 'phone-rumble', id, ms }));
/** O último "Jogador N" mandado a cada celular (só manda de novo quando muda). */
const phoneLabels = new Map<string, number | null>();
function syncPhoneLabels(): void {
  const players = getPlayerGamepads();
  for (const phone of store.get().phonePads) {
    const index = phonePadIndex(phone.id);
    const position = index === null ? -1 : players.findIndex((p) => p?.index === index);
    const player = position >= 0 ? position + 1 : null;
    if (phoneLabels.has(phone.id) && phoneLabels.get(phone.id) === player) continue;
    phoneLabels.set(phone.id, player);
    connection.send({ type: 'phone-label', id: phone.id, player });
  }
}
window.setInterval(syncPhoneLabels, 500);
function phoneNotice(text: string): void {
  if (frame.isOpen) gameToast.info(text);
  else home.notify(text);
}
function playerOf(phoneId: string): number | null {
  const index = phonePadIndex(phoneId);
  const position = getPlayerGamepads().findIndex((p) => p?.index === index);
  return position >= 0 ? position + 1 : null;
}

// ---- Bateria fraca: avisa no menu ou por cima do jogo ----
const lowBattery = new LowBatteryWatcher((device) => {
  const text = `Bateria fraca: ${device.name} (${device.battery}%)`;
  sounds.error();
  if (frame.isOpen) gameToast.show(text);
  else home.notify(text, 'error');
});

// ---- Eventos do daemon ----
/** Reiniciando para atualizar: quando o daemon voltar, recarrega a página (o launcher novo vem junto). */
let restartingForUpdate = false;
connection.onStatus((connected) => {
  // Para o vigia do index.html: a tela abriu e conectou (não precisa recarregar).
  if (connected) (window as unknown as { __playzinConnected?: boolean }).__playzinConnected = true;
  if (connected && restartingForUpdate) return location.reload();
  home.setConnected(connected);
  if (!connected && store.get().status !== 'playing') store.update({ status: 'connecting' });
});

function setCartridge(cartridge: CartridgeInfo): void {
  void library.remember(cartridge);
  store.update({ status: 'ready', cartridge });
}

connection.onMessage((msg) => {
  const { status, cartridge } = store.get();
  switch (msg.type) {
    case 'state': {
      if (!msg.cartridge) {
        if (status === 'playing') {
          stopPlaying();
          store.notify('Cartucho removido');
        }
        store.update({ status: 'empty', cartridge: null });
      } else if (status === 'playing' && cartridge?.slotId === msg.cartridge.slotId) {
        // Reconectou no meio do jogo e nada mudou: continua jogando.
      } else if (cartridge?.slotId === msg.cartridge.slotId) {
        store.update({ status: 'ready' });
      } else {
        if (status === 'playing') stopPlaying();
        setCartridge(msg.cartridge);
      }
      break;
    }
    case 'cartridge-inserted':
      if (status === 'playing') stopPlaying();
      setCartridge(msg.cartridge);
      break;
    case 'cartridge-removed':
      if (cartridge?.slotId !== msg.slotId) break;
      if (status === 'playing') stopPlaying();
      store.update({ status: 'empty', cartridge: null });
      store.notify('Cartucho removido');
      break;
    case 'profiles':
      home.onProfiles(msg.profiles);
      break;
    case 'bluetooth':
      store.update({ bluetooth: msg.state });
      lowBattery.update(msg.state);
      break;
    case 'bluetooth-paired':
      home.onBluetoothPaired(msg.device, msg.auto);
      break;
    case 'bluetooth-error':
      home.showError(msg.message);
      break;
    case 'wifi':
      store.update({ wifi: msg.state });
      break;
    case 'power':
      store.update({ power: msg.state });
      break;
    case 'power-action':
      // Desligando com um jogo aberto (pela API): fecha antes, para gravar saves e tempo de jogo.
      if (frame.isOpen) stopPlaying();
      home.onPowerAction(msg.action, msg.simulated);
      break;
    case 'power-error':
      home.onPowerError(msg.message);
      break;
    case 'update': {
      store.update({ update: msg.state });
      const u = msg.state;
      // Cada aviso uma vez só (o console lembra qual já mostrou).
      const once = (key: string, value: string, show: () => void) => {
        try {
          if (localStorage.getItem(key) === value) return;
          localStorage.setItem(key, value);
        } catch {
          /* sem localStorage: mostra mesmo assim */
        }
        show();
      };
      if (u.justUpdated) once('playzin:launcher:update-done', u.justUpdated.to, () => home.notifyUpdate(`Playzin atualizado para a versão ${u.justUpdated!.to}`));
      if (u.rolledBack) {
        once('playzin:launcher:update-failed', u.rolledBack.from, () =>
          home.notifyUpdate(`A versão ${u.rolledBack!.from} não funcionou: o console voltou para a ${u.rolledBack!.to}`, 'error'),
        );
      }
      if (u.available && u.phase === 'idle') {
        once('playzin:launcher:update-seen', u.available.version, () =>
          home.notifyUpdate(`Atualização disponível: Playzin ${u.available!.version} (em Configurações)`),
        );
      }
      break;
    }
    case 'backup': {
      const prev = store.get().backup;
      store.update({ backup: msg.state });
      const result = msg.state.result;
      // Restaurou enquanto esta tela estava aberta: recarrega (perfis, saves, tempo de jogo... tudo do
      // backup) e avisa depois. Só reage à MUDANÇA: a primeira mensagem depois de carregar a página
      // (prev ainda null) já vem com o "restaurado" de antes e não pode recarregar de novo (seria um loop).
      if (prev && result?.kind === 'restore' && prev.result?.at !== result.at) {
        try {
          sessionStorage.setItem('playzin:launcher:restored', result.id);
        } catch {
          /* sem sessionStorage: recarrega sem o aviso */
        }
        if (frame.isOpen) stopPlaying();
        location.reload();
      }
      break;
    }
    case 'backup-drive':
      if (frame.isOpen) gameToast.info(`Pendrive conectado: ${msg.name}`);
      else home.notifyUpdate(`Pendrive conectado: dá para guardar os saves nele (Configurações → Backup no pendrive)`);
      break;
    case 'update-restarting':
      // O daemon sai e volta na versão nova; quando ele voltar, a página recarrega (launcher novo).
      if (frame.isOpen) stopPlaying();
      restartingForUpdate = true;
      home.onUpdateRestarting(msg.version);
      break;
    case 'phone-pads': {
      const { added, removed } = setPhonePads(msg.pads);
      store.update({ phonePads: msg.pads });
      // Voltou (ou entrou): manda o número do jogador de novo.
      for (const pad of added) phoneLabels.delete(pad.phoneId);
      for (const pad of removed) phoneLabels.delete(pad.phoneId);
      if (added.length || removed.length) window.dispatchEvent(new Event(added.length ? 'gamepadconnected' : 'gamepaddisconnected'));
      syncPhoneLabels();
      break;
    }
    case 'phone-input':
      phoneInput(msg.id, msg.b, msg.x, msg.y);
      break;
    case 'phone-pairing':
      store.update({ phonePairing: msg.pairing });
      break;
    case 'phone-joined': {
      sounds.insert();
      const player = playerOf(msg.pad.id);
      phoneNotice(player ? `Celular conectado: Jogador ${player}` : `Celular conectado: ${msg.pad.name}`);
      break;
    }
    case 'phone-left':
      sounds.eject();
      phoneNotice(`Celular desconectado: ${msg.pad.name}`);
      break;
    case 'wifi-connected':
      home.onWifiConnected(msg.ssid);
      break;
    case 'wifi-error':
      home.onWifiError(msg.message, msg.ssid, Boolean(msg.wrongPassword));
      break;
    case 'cartridge-error':
      sounds.error();
      store.notify('Cartucho inválido: confira o playzin.json', 'error');
      console.warn(msg.message);
      break;
  }
});

connection.connect();

// Voltou de uma restauração de backup: avisa (a página foi recarregada para ler tudo de novo).
try {
  if (sessionStorage.getItem('playzin:launcher:restored')) {
    sessionStorage.removeItem('playzin:launcher:restored');
    window.setTimeout(() => home.notifyUpdate('Backup restaurado: perfis, saves e conquistas voltaram'), 3500);
  }
} catch {
  /* sem sessionStorage */
}

// ---- Cursor: escondido, a não ser que alguém mexa no mouse ----
let cursorTimer: number | undefined;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.body.classList.add('hide-cursor'), 2500);
});
