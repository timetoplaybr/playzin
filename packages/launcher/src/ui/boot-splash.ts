import type { Sounds } from './sounds';

/** Duração da abertura completa (ms), sem contar o sumiço final. */
const DURATION = 2600;
const FADE = 450;

/**
 * Abertura do Playzin ao ligar: um cartucho desce e encaixa na fenda, o nome aparece letra
 * por letra e toca um acorde de boas-vindas. Qualquer botão, tecla ou clique pula.
 * Desenho e sons próprios do Playzin.
 */
export class BootSplash {
  private readonly el: HTMLDivElement;
  private timers: number[] = [];
  private closing = false;
  private done = false;
  private resolveFinished!: () => void;
  /** Resolve quando a abertura sumiu da tela. */
  readonly finished = new Promise<void>((resolve) => (this.resolveFinished = resolve));

  constructor(
    host: HTMLElement,
    private readonly sounds: Sounds,
  ) {
    const letters = [...'Playzin']
      .map((c, i) => `<span class="boot-letter${i >= 4 ? ' accent' : ''}" style="--i:${i}">${c}</span>`)
      .join('');
    this.el = document.createElement('div');
    this.el.className = 'boot';
    this.el.innerHTML = `
      <div class="boot-mark">
        <div class="boot-slot-area">
          <div class="boot-cart"><span class="boot-cart-label"></span><span class="boot-cart-grip"></span></div>
        </div>
        <div class="boot-slot"></div>
        <div class="boot-ring"></div>
      </div>
      <div class="boot-word" aria-label="Playzin">${letters}</div>
      <div class="boot-tagline">seu console de cartuchos</div>`;
    host.append(this.el);
    this.el.addEventListener('pointerdown', () => this.skip());

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) this.el.classList.add('reduced');
    this.at(520, () => this.sounds.bootClick());
    this.at(1250, () => this.sounds.bootChime());
    this.at(reduced ? 1200 : DURATION, () => this.skip());
  }

  get isOpen(): boolean {
    return !this.done;
  }

  /** Encerra a abertura (com o sumiço suave). */
  skip(): void {
    if (this.closing) return;
    this.closing = true;
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers = [];
    this.el.classList.add('leaving');
    window.setTimeout(() => {
      this.el.remove();
      this.done = true;
      this.resolveFinished();
    }, FADE);
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }
}
