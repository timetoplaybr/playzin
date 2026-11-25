import type { PowerAction } from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

interface Deps {
  store: ConsoleStore;
  sounds: Sounds;
  host(): HTMLElement;
  toast(text: string, kind?: 'info' | 'error'): void;
  hintsChanged(): void;
}

const OPTIONS: { action: PowerAction; label: string; meta: string; icon: string }[] = [
  { action: 'poweroff', label: 'Desligar o console', meta: 'Espere a tela apagar antes de tirar da tomada', icon: icons.power },
  { action: 'reboot', label: 'Reiniciar o console', meta: 'Desliga e liga de novo sozinho', icon: icons.refresh },
];

/**
 * Painel "Desligar": desligar ou reiniciar o console de verdade (no Pi), sem puxar da tomada.
 *   ↑/↓ = opção · A = confirmar · B = cancelar
 */
export class PowerPanel {
  private index = 0;
  private sending = false;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.index = 0;
    this.sending = false;
  }

  private get supported(): boolean {
    return this.deps.store.get().power?.backend !== 'none';
  }

  render(): void {
    const host = this.deps.host();
    const backend = this.deps.store.get().power?.backend;
    if (!this.supported) {
      host.innerHTML = `
        <h2>${icons.power} Desligar</h2>
        <p class="muted">Este console não consegue se desligar sozinho. Use o botão do console.</p>`;
      return;
    }
    const rows = OPTIONS.map(
      (o, i) =>
        `<li class="power-option${i === this.index ? ' selected' : ''}" data-index="${i}">` +
        `<span class="kind-icon">${o.icon}</span><span class="save-name">${o.label}</span>` +
        `<span class="save-meta">${o.meta}</span></li>`,
    ).join('');
    host.innerHTML = `
      <h2>${icons.power} Desligar</h2>
      <ul class="save-list power-list">${rows}</ul>
      <p class="muted">${
        backend === 'mock'
          ? 'No computador, desligar e reiniciar são só simulados: a tela apaga, o computador não.'
          : 'O progresso dos jogos já fica salvo no console. Desligar por aqui evita estragar o cartão de memória.'
      }</p>`;
    host.querySelectorAll<HTMLElement>('.power-option').forEach((li) =>
      li.addEventListener('click', () => {
        const i = Number(li.dataset.index);
        if (i !== this.index) {
          this.index = i;
          this.deps.sounds.move();
          this.render();
        }
        void this.run();
      }),
    );
    this.deps.hintsChanged();
  }

  handleInput(input: PanelInput): 'close' | void {
    if (input.justPressed('back')) return 'close';
    if (!this.supported) {
      if (input.justPressed('confirm')) return 'close';
      return;
    }
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action)) continue;
      const next = Math.max(0, Math.min(OPTIONS.length - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.deps.sounds.move();
        this.render();
      }
    }
    if (input.justPressed('confirm')) void this.run();
  }

  hints(hint: (glyph: string, label: string) => string): string {
    return (this.supported ? hint('A', OPTIONS[this.index]!.action === 'reboot' ? 'Reiniciar' : 'Desligar') : '') + hint('B', 'Cancelar');
  }

  /** Pede ao daemon. A tela de "Desligando…" aparece quando o daemon avisa (power-action). */
  private async run(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const res = await fetch('/api/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: OPTIONS[this.index]!.action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `erro ${res.status}`);
      }
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast((err as Error).message || 'Não foi possível desligar', 'error');
    } finally {
      this.sending = false;
    }
  }
}
