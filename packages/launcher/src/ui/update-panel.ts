import type { UpdateState } from '@playzin/shared';
import { formatLastPlayed } from '../playtime';
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

type ActionId = 'check' | 'download' | 'install';

/**
 * Configurações → Atualização do sistema. Um botão só, que muda com o momento:
 *   Procurar atualização → Baixar a versão X → Instalar e reiniciar (A duas vezes)
 * Baixar e conferir acontecem sem pressa; instalar só com a confirmação aqui na TV.
 *   A = fazer · B = voltar
 */
export class UpdatePanel {
  private confirming = false;
  private busy = false;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.confirming = false;
  }

  private state(): UpdateState | null {
    return this.deps.store.get().update;
  }

  private action(): { id: ActionId; label: string } | null {
    const s = this.state();
    if (!s?.supported) return null;
    if (s.phase === 'ready' && s.available) {
      return { id: 'install', label: this.confirming ? 'Aperte A de novo: o console reinicia' : 'Instalar e reiniciar' };
    }
    if (s.phase !== 'idle') return null;
    if (s.available) return { id: 'download', label: `Baixar a versão ${s.available.version}` };
    return { id: 'check', label: 'Procurar atualização' };
  }

  handleInput(input: PanelInput): 'close' | void {
    if (input.justPressed('back')) return 'close';
    if (input.justPressed('confirm')) void this.run();
  }

  hints(hint: (glyph: string, label: string) => string): string {
    const a = this.action();
    return (a ? hint('A', a.id === 'install' ? 'Instalar' : a.id === 'download' ? 'Baixar' : 'Procurar') : '') + hint('B', 'Voltar');
  }

  private async run(): Promise<void> {
    const a = this.action();
    if (!a || this.busy) return;
    if (a.id === 'install' && !this.confirming) {
      this.confirming = true;
      this.deps.sounds.error();
      this.render();
      return;
    }
    this.confirming = false;
    this.busy = true;
    this.deps.sounds.select();
    try {
      const res = await fetch(`/api/update/${a.id}`, { method: 'POST' });
      // Os erros de procurar e baixar aparecem na própria tela (vêm no estado, pelo WebSocket).
      if (!res.ok && a.id === 'install') {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `erro ${res.status}`);
      }
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast((err as Error).message || 'Não foi possível falar com o console', 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render(): void {
    const host = this.deps.host();
    const s = this.state();
    const head = `<h2>${icons.refresh} Atualização do sistema</h2>
      <div class="upd-version"><span>Versão instalada</span><b>Playzin ${escapeHtml(s?.version ?? '…')}</b></div>`;
    if (!s) {
      host.innerHTML = `${head}<p class="muted">Conectando ao sistema…</p>`;
      return this.deps.hintsChanged();
    }

    let body: string;
    const notes = s.available?.notes ? `<div class="upd-notes">${escapeHtml(s.available.notes)}</div>` : '';
    const size = s.available ? ` · ${(s.available.size / 1_000_000).toFixed(1).replace('.', ',')} MB` : '';
    if (!s.supported) {
      body = `<p class="muted">${escapeHtml(s.problem ?? 'A atualização pelo Wi-Fi não funciona aqui.')}</p>`;
    } else if (s.phase === 'checking') {
      body = `<p class="upd-status"><span class="mini-spinner"></span>Procurando atualizações…</p>`;
    } else if (s.phase === 'downloading') {
      const pct = Math.round(s.progress * 100);
      body =
        `<p class="upd-status">Baixando o Playzin ${escapeHtml(s.available?.version ?? '')}… ${pct}%</p>` +
        `<div class="upd-bar"><span style="width:${pct}%"></span></div>` +
        `<p class="muted">Pode continuar usando o console enquanto isso.</p>`;
    } else if (s.phase === 'installing') {
      body = `<p class="upd-status"><span class="mini-spinner"></span>Instalando…</p>`;
    } else if (s.phase === 'ready' && s.available) {
      body =
        `<p class="upd-status ok">${icons.cartridge}Playzin ${escapeHtml(s.available.version)} baixado e conferido${size}</p>${notes}` +
        `<p class="muted">Ao instalar, o console reinicia sozinho (leva menos de um minuto). Saves, perfis e configurações continuam. ` +
        `Se a versão nova não funcionar, ele volta sozinho para a ${escapeHtml(s.version)}.</p>`;
    } else if (s.available) {
      body = `<p class="upd-status new">Nova versão: Playzin ${escapeHtml(s.available.version)}${size}</p>${notes}`;
    } else {
      body =
        `<p class="upd-status ok">${icons.cartridge}O Playzin está atualizado.</p>` +
        `<p class="muted">${s.lastCheckedAt ? `Última procura: ${formatLastPlayed(s.lastCheckedAt)}. ` : ''}O console também procura sozinho uma vez por dia.</p>`;
    }
    if (s.error) body += `<p class="upd-error">${escapeHtml(s.error)}</p>`;

    const a = this.action();
    const button = a
      ? `<button class="gp-action selected${this.confirming ? ' confirming' : ''}${a.id === 'install' ? ' primary' : ''}" id="upd-action">${a.id === 'install' ? icons.power : icons.refresh}<span>${escapeHtml(a.label)}</span></button>`
      : '';
    host.innerHTML = `${head}${body}<div class="upd-actions">${button}</div>`;
    host.querySelector('#upd-action')?.addEventListener('click', () => void this.run());
    this.deps.hintsChanged();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
