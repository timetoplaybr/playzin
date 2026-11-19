import type { CartridgeInfo } from '@playzin/shared';
import { DaemonConnection } from './connection';
import { GameFrame } from './game-frame';
import { Library } from './library';
import { ConsoleStore } from './store';
import { HomeUI, STAGE_HEIGHT, STAGE_WIDTH } from './ui/home';
import { Sounds } from './ui/sounds';
import './style.css';

const store = new ConsoleStore();
const connection = new DaemonConnection();
const library = new Library();
const sounds = new Sounds();
const stage = document.getElementById('home') as HTMLElement;

// ---- Palco fixo de 1280x720, escalado para caber em qualquer TV/monitor ----
function fitStage(): void {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
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
});

function play(cartridge: CartridgeInfo): void {
  if (frame.isOpen) return;
  library.markPlayed(cartridge.manifest.id);
  const profile = store.profile();
  if (!profile) return home.openProfiles();
  store.update({ status: 'playing' });
  home.setActive(false);
  frame.open(cartridge, profile.id);
}

function stopPlaying(): void {
  if (!frame.isOpen) return;
  frame.close();
  home.setActive(true);
  void frame.lastPlaytimeSaved.then(() => home.refreshPlaytime());
}

const home = new HomeUI(stage, store, library, sounds, { play });

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
