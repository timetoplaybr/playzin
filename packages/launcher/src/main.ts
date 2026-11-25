import type { CartridgeInfo } from '@playzin/shared';
import { DaemonConnection } from './connection';
import { GameFrame } from './game-frame';
import { Library } from './library';
import { ConsoleStore } from './store';
import { HomeUI, STAGE_HEIGHT, STAGE_WIDTH } from './ui/home';
import { LowBatteryWatcher } from './ui/battery';
import { GameToast } from './ui/game-toast';
import { Sounds } from './ui/sounds';
import { restoreTheme } from './ui/theme';
import './style.css';

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

// ---- Jogo do cartucho (iframe) ----
const frame = new GameFrame(() => {
  // Voltou do jogo pelo atalho ou pelo SDK: o cartucho continua inserido.
  home.setActive(true);
  void frame.lastPlaytimeSaved.then(() => home.refreshPlaytime());
  sounds.back();
  const { cartridge } = store.get();
  store.update({ status: cartridge ? 'ready' : 'empty' });
}, sounds);
fitStage(); // o menu rápido acabou de entrar na página

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

const home = new HomeUI(stage, store, library, sounds, { play });

// ---- Bateria fraca: avisa no menu ou por cima do jogo ----
const gameToast = new GameToast();
fitStage(); // o aviso por cima do jogo usa o mesmo palco escalado
const lowBattery = new LowBatteryWatcher((device) => {
  const text = `Bateria fraca: ${device.name} (${device.battery}%)`;
  sounds.error();
  if (frame.isOpen) gameToast.show(text);
  else home.notify(text, 'error');
});

// ---- Eventos do daemon ----
connection.onStatus((connected) => {
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

// ---- Cursor: escondido, a não ser que alguém mexa no mouse ----
let cursorTimer: number | undefined;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.body.classList.add('hide-cursor'), 2500);
});
