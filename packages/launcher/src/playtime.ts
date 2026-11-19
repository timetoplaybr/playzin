import { getConnectedGamepads } from '@playzin/sdk';

/** De quanto em quanto tempo o launcher avisa o daemon (o máximo que um desligamento perde). */
const FLUSH_EVERY_MS = 30_000;
/** Sem nenhum botão, tecla ou mouse por este tempo, o relógio para (jogo esquecido ligado). */
const IDLE_AFTER_MS = 10 * 60_000;
const TICK_MS = 1000;

/**
 * Mede o tempo de jogo ativo de uma partida e envia ao daemon aos pedaços.
 * Só conta enquanto a tela está visível e alguém mexeu em algo nos últimos 10 minutos.
 */
export class PlaytimeTracker {
  private session: { profile: string; game: string; name: string; id: string } | null = null;
  private pendingMs = 0;
  private lastTick = 0;
  private lastInput = 0;
  private lastFlush = 0;
  private timer: number | undefined;
  private padSignature = '';
  private detachWindow: (() => void) | undefined;
  private readonly onInput = () => (this.lastInput = performance.now());

  constructor() {
    // Página fechando (reinício, F5): manda o que faltar.
    window.addEventListener('pagehide', () => void this.flush(true));
  }

  start(profile: string, game: string, name: string): void {
    void this.stop();
    this.session = { profile, game, name, id: newSessionId() };
    this.pendingMs = 0;
    this.lastTick = this.lastInput = this.lastFlush = performance.now();
    this.padSignature = '';
    this.attach(window);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  /** O jogo carregou no iframe: escuta teclado e mouse lá dentro também. */
  watchWindow(win: Window | null): void {
    if (!win || win === window) return;
    this.detachWindow?.();
    this.detachWindow = this.attach(win);
  }

  /** Fim da partida: envia o restante. Resolve quando o daemon guardou. */
  async stop(): Promise<void> {
    if (!this.session) return;
    this.tick();
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.detachWindow?.();
    this.detachWindow = undefined;
    this.detach(window);
    await this.flush(false);
    this.session = null;
  }

  private tick(): void {
    if (!this.session) return;
    const now = performance.now();
    const elapsed = Math.min(now - this.lastTick, 5 * TICK_MS); // computador suspenso não conta
    this.lastTick = now;
    this.checkGamepads(now);
    const visible = document.visibilityState === 'visible';
    if (visible && now - this.lastInput < IDLE_AFTER_MS) this.pendingMs += elapsed;
    if (now - this.lastFlush >= FLUSH_EVERY_MS) void this.flush(false);
  }

  private async flush(leaving: boolean): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.lastFlush = performance.now();
    const seconds = Math.floor(this.pendingMs / 1000);
    if (seconds <= 0) return;
    this.pendingMs -= seconds * 1000;
    const url = `/api/playtime/${encodeURIComponent(session.profile)}/${encodeURIComponent(session.game)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds, name: session.name, session: session.id }),
        keepalive: leaving,
      });
      if (!res.ok && res.status >= 500) throw new Error(String(res.status));
    } catch {
      // Daemon fora do ar: guarda para o próximo envio (até o limite de um envio).
      if (!leaving) this.pendingMs = Math.min(this.pendingMs + seconds * 1000, 120_000);
    }
  }

  /** Controle conta como "alguém jogando" quando algum botão ou analógico muda. */
  private checkGamepads(now: number): void {
    let signature = '';
    for (const pad of getConnectedGamepads()) {
      signature += pad.buttons.map((b) => (b.pressed ? 1 : 0)).join('');
      signature += pad.axes.map((a) => Math.round(a * 4)).join(',');
    }
    if (signature !== this.padSignature) {
      if (this.padSignature) this.lastInput = now;
      this.padSignature = signature;
    }
  }

  private attach(win: Window): () => void {
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const;
    try {
      for (const e of events) win.addEventListener(e, this.onInput, { passive: true, capture: true });
    } catch {
      return () => undefined; // iframe de outra origem
    }
    return () => {
      try {
        for (const e of events) win.removeEventListener(e, this.onInput, { capture: true });
      } catch {
        /* iframe já descarregado */
      }
    };
  }

  private detach(win: Window): void {
    for (const e of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
      win.removeEventListener(e, this.onInput, { capture: true });
    }
  }
}

/** "3 h 12 min", "45 min", "menos de 1 min". */
export function formatPlaytime(seconds: number): string {
  if (seconds < 60) return 'menos de 1 min';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** "Hoje, 10:31", "Ontem", "há 3 dias", "05/11". */
export function formatLastPlayed(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days <= 0) return `Hoje, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return 'Ontem';
  if (days < 7) return `há ${days} dias`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function formatSessions(n: number): string {
  return n === 1 ? '1 vez' : `${n} vezes`;
}
