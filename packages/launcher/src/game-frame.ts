import { GamepadButton, getConnectedGamepads } from '@playzin/sdk';
import type { CartridgeInfo, GameToLauncherMessage } from '@playzin/shared';

const HOLD_TO_EXIT_MS = 1000;

/** O que o script de saves injetado pelo daemon expõe dentro do iframe do jogo. */
interface GameSaves {
  snapshot(): Record<string, string>;
  url: string;
}
const READY_FALLBACK_MS = 400;

/**
 * Roda o jogo do cartucho num iframe em tela cheia por cima do menu.
 * O launcher continua vivo por baixo, então ele percebe a remoção do cartucho
 * e os atalhos de "voltar ao menu" mesmo que o jogo não use o SDK.
 *
 * Atalhos para sair do jogo:
 *  - botão Xbox (Guide), ou View + Menu segurados por 1 s
 *  - Esc segurado por 1 s
 *  - o jogo chama exitToMenu() do SDK
 */
export class GameFrame {
  private readonly frame = document.getElementById('cartridge-frame') as HTMLIFrameElement;
  private readonly loading = document.getElementById('loading') as HTMLDivElement;
  private readonly loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
  private current: CartridgeInfo | null = null;
  private rafId: number | undefined;
  private comboSince: number | null = null;
  private escSince: number | null = null;
  private escTimer: number | undefined;
  private detachKeyboard: (() => void) | undefined;

  constructor(private readonly onExit: () => void) {
    window.addEventListener('message', (event) => this.onMessage(event));
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  open(cartridge: CartridgeInfo): void {
    this.current = cartridge;
    this.loadingText.textContent = `Carregando ${cartridge.manifest.name}…`;
    this.loading.hidden = false;

    const url = new URL(cartridge.entryUrl, location.href);
    url.searchParams.set('playzin', '1');

    this.frame.onload = () => {
      this.attachKeyboard();
      // Jogos sem o SDK nunca mandam "ready": mostramos mesmo assim.
      window.setTimeout(() => this.reveal(), READY_FALLBACK_MS);
    };
    this.frame.src = url.toString();
    this.frame.hidden = false;
    this.watchGamepads();
  }

  close(): void {
    if (!this.current) return;
    this.saveNow();
    this.current = null;
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
    this.detachKeyboard?.();
    this.detachKeyboard = undefined;
    window.clearTimeout(this.escTimer);
    this.comboSince = this.escSince = null;
    // about:blank descarrega o jogo de verdade (para áudio, timers, WebGL).
    this.frame.onload = null;
    this.frame.src = 'about:blank';
    this.frame.hidden = true;
    this.loading.hidden = true;
    window.focus();
  }

  /**
   * Última gravação dos saves antes de descarregar o jogo. Quem envia é o launcher
   * (que continua vivo), então não há limite de tamanho nem risco de a página fechar antes.
   */
  private saveNow(): void {
    try {
      const saves = (this.frame.contentWindow as unknown as { __playzinSaves?: GameSaves } | null)?.__playzinSaves;
      if (!saves) return;
      const body = JSON.stringify({ data: saves.snapshot(), at: Date.now() });
      void fetch(saves.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }).catch(() => undefined);
    } catch {
      /* iframe já descarregado ou de outra origem */
    }
  }

  private reveal(): void {
    if (!this.current) return;
    this.loading.hidden = true;
    this.frame.focus();
    this.frame.contentWindow?.focus();
  }

  private requestExit(): void {
    if (!this.current) return;
    this.close();
    this.onExit();
  }

  private onMessage(event: MessageEvent): void {
    if (event.origin !== location.origin || event.source !== this.frame.contentWindow) return;
    const data = event.data as Partial<GameToLauncherMessage> | undefined;
    if (data?.source !== 'playzin-sdk') return;
    if (data.type === 'ready') this.reveal();
    if (data.type === 'exit') this.requestExit();
  }

  /** O jogo é da mesma origem, então dá para escutar o teclado dentro do iframe. */
  private attachKeyboard(): void {
    this.detachKeyboard?.();
    const win = this.frame.contentWindow;
    if (!win) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || this.escSince !== null) return;
      this.escSince = performance.now();
      this.escTimer = window.setTimeout(() => this.requestExit(), HOLD_TO_EXIT_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      this.escSince = null;
      window.clearTimeout(this.escTimer);
    };
    try {
      win.addEventListener('keydown', down);
      win.addEventListener('keyup', up);
      this.detachKeyboard = () => {
        try {
          win.removeEventListener('keydown', down);
          win.removeEventListener('keyup', up);
        } catch {
          /* iframe já descarregado */
        }
      };
    } catch {
      /* origem diferente: só sobra o SDK e o controle */
    }
  }

  private watchGamepads(): void {
    const tick = () => {
      if (!this.current) return;
      const now = performance.now();
      let guide = false;
      let combo = false;
      for (const pad of getConnectedGamepads()) {
        if (pad.buttons[GamepadButton.GUIDE]?.pressed) guide = true;
        if (pad.buttons[GamepadButton.VIEW]?.pressed && pad.buttons[GamepadButton.MENU]?.pressed) combo = true;
      }
      if (guide) return this.requestExit();
      if (combo) {
        this.comboSince ??= now;
        if (now - this.comboSince >= HOLD_TO_EXIT_MS) return this.requestExit();
      } else {
        this.comboSince = null;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
}
