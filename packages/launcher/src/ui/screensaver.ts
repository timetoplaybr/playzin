import { getConnectedGamepads } from '@playzin/sdk';
import { icons } from './icons';

/** Opções da tela Configurações, em minutos (0 = nunca). */
export const SCREENSAVER_OPTIONS = [2, 5, 10, 15, 30, 0] as const;
export type ScreensaverMinutes = (typeof SCREENSAVER_OPTIONS)[number];
const DEFAULT_MINUTES: ScreensaverMinutes = 5;
/** Jogando, espera pelo menos isto (cena sem controle, alguém lendo um texto longo...). */
const MIN_IN_GAME_MINUTES = 15;
const SETTING_KEY = 'playzin:launcher:screensaver';
/** De quanto em quanto tempo o relógio troca de lugar (nada fica parado na TV). */
const MOVE_EVERY_MS = 20_000;
const POLL_MS = 250;
/** Depois de acordar, o menu ignora os botões por este tempo (o aperto que acordou não vaza). */
const SWALLOW_MS = 400;

export interface ScreensaverHooks {
  /** O jogo está aberto agora? (Muda o tempo de espera e pausa o jogo.) */
  isPlaying(): boolean;
  /** Proteção ligou/desligou: o launcher pausa e retoma o jogo. */
  onStart(): void;
  onEnd(): void;
}

/**
 * Protetor de tela: depois de um tempo sem ninguém mexer em controle, teclado ou mouse, a tela
 * escurece e mostra só o relógio, que muda de lugar de tempos em tempos. Protege TVs OLED de
 * marcar a imagem do menu (ou de um jogo pausado) e economiza energia. Qualquer botão acorda,
 * e esse aperto não chega ao menu nem ao jogo.
 */
export class Screensaver {
  private readonly el: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private minutes: ScreensaverMinutes;
  private lastInput = performance.now();
  private open = false;
  private wokeAt = 0;
  private padSignature = '';
  private moveTimer: number | undefined;
  private clockTimer: number | undefined;
  private detachGame: (() => void) | undefined;
  private readonly onInput = () => this.activity();

  constructor(private readonly hooks: ScreensaverHooks) {
    this.minutes = readSetting();
    this.el = document.createElement('div');
    this.el.id = 'screensaver';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="ss-clock">
        <div class="ss-time"></div>
        <div class="ss-date"></div>
        <div class="ss-brand">${icons.cartridge}Playzin</div>
      </div>`;
    document.body.appendChild(this.el);
    this.clock = this.el.querySelector('.ss-clock') as HTMLDivElement;
    this.attach(window);
    window.setInterval(() => this.tick(), POLL_MS);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** O menu deve ignorar os botões agora? (Protegendo, ou acabou de acordar.) */
  get blocksInput(): boolean {
    return this.open || performance.now() - this.wokeAt < SWALLOW_MS;
  }

  get setting(): ScreensaverMinutes {
    return this.minutes;
  }

  /** Troca o tempo (Configurações). Conta do zero a partir de agora. */
  set(minutes: ScreensaverMinutes): void {
    this.minutes = minutes;
    this.lastInput = performance.now();
    try {
      localStorage.setItem(SETTING_KEY, String(minutes));
    } catch {
      /* sem localStorage: vale até o console desligar */
    }
  }

  /** O jogo carregou no iframe: o teclado e o mouse de lá também contam como "alguém mexeu". */
  watchGame(win: Window | null): void {
    this.detachGame?.();
    this.detachGame = win && win !== window ? this.attach(win) : undefined;
  }

  /** Liga agora (botão "Ver agora" das Configurações). */
  start(): void {
    if (this.open) return;
    this.open = true;
    this.updateClock();
    this.place();
    this.el.hidden = false;
    // Força o navegador a aplicar o estado inicial antes de começar o escurecimento.
    void this.el.offsetWidth;
    this.el.classList.add('on');
    this.moveTimer = window.setInterval(() => this.place(), MOVE_EVERY_MS);
    this.clockTimer = window.setInterval(() => this.updateClock(), 5000);
    this.hooks.onStart();
  }

  private stop(): void {
    if (!this.open) return;
    this.open = false;
    this.wokeAt = performance.now();
    this.lastInput = this.wokeAt;
    window.clearInterval(this.moveTimer);
    window.clearInterval(this.clockTimer);
    this.el.classList.remove('on');
    this.el.hidden = true;
    this.hooks.onEnd();
  }

  private activity(): void {
    this.lastInput = performance.now();
    if (this.open) this.stop();
  }

  private tick(): void {
    // Controles: qualquer botão ou analógico fora do centro conta como "mexeu".
    const signature = getConnectedGamepads()
      .map((p) => `${p.index}:${p.buttons.map((b) => (b.pressed ? 1 : 0)).join('')}:${p.axes.map((a) => (Math.abs(a) > 0.5 ? Math.sign(a) : 0)).join(',')}`)
      .join('|');
    if (signature !== this.padSignature) {
      const first = this.padSignature === '';
      this.padSignature = signature;
      if (!first) return this.activity();
    }
    if (this.open || this.minutes === 0) return;
    const minutes = this.hooks.isPlaying() ? Math.max(this.minutes, MIN_IN_GAME_MINUTES) : this.minutes;
    if (performance.now() - this.lastInput >= minutes * 60_000) this.start();
  }

  /** Lugar novo para o relógio, sempre dentro da tela. */
  private place(): void {
    const x = 10 + Math.random() * 55; // % da largura (o relógio ocupa ~30%)
    const y = 12 + Math.random() * 55;
    this.clock.classList.remove('shown');
    window.setTimeout(() => {
      this.clock.style.left = `${x}%`;
      this.clock.style.top = `${y}%`;
      this.clock.classList.add('shown');
    }, this.clock.style.left ? 900 : 0); // espera sumir antes de reaparecer em outro lugar
  }

  private updateClock(): void {
    const now = new Date();
    (this.el.querySelector('.ss-time') as HTMLElement).textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    // "quinta-feira, 26 de novembro" → "Quinta-feira, 26 de novembro"
    (this.el.querySelector('.ss-date') as HTMLElement).textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }

  private attach(win: Window): () => void {
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;
    try {
      for (const e of events) win.addEventListener(e, this.onInput, { passive: true, capture: true });
    } catch {
      return () => undefined; // janela de outra origem
    }
    return () => {
      try {
        for (const e of events) win.removeEventListener(e, this.onInput, { capture: true });
      } catch {
        /* iframe já descarregado */
      }
    };
  }
}

/** "5 minutos", "Nunca"... */
export function screensaverLabel(minutes: ScreensaverMinutes): string {
  return minutes === 0 ? 'Nunca' : `${minutes} minutos`;
}

function readSetting(): ScreensaverMinutes {
  try {
    const value = Number(localStorage.getItem(SETTING_KEY));
    if (localStorage.getItem(SETTING_KEY) !== null && (SCREENSAVER_OPTIONS as readonly number[]).includes(value)) {
      return value as ScreensaverMinutes;
    }
  } catch {
    /* sem localStorage */
  }
  return DEFAULT_MINUTES;
}
