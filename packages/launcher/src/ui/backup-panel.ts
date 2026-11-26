import type { BackupContents, BackupEntry, BackupState } from '@playzin/shared';
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

type Item = { type: 'shots' } | { type: 'create' } | { type: 'restore'; backup: BackupEntry };

/**
 * Configurações → Backup no pendrive. Com um pendrive comum (sem jogo) no console:
 *   - "Incluir as capturas" (←/→ ou A) e "Fazer backup agora";
 *   - os backups que estão no pendrive: A duas vezes restaura um deles (antes, o console guarda
 *     no pendrive uma cópia do que tem agora, para dar para voltar atrás).
 *   ↑/↓ = escolher · A = fazer · B = voltar
 */
export class BackupPanel {
  private index = 1;
  private withShots = true;
  private confirming: string | null = null;
  private busy = false;
  /** Itens na última vez que desenhou (para notar quando o pendrive chega). */
  private lastCount = 0;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.index = 1;
    this.confirming = null;
    this.lastCount = 0;
  }

  private state(): BackupState | null {
    return this.deps.store.get().backup;
  }

  private items(): Item[] {
    const s = this.state();
    if (!s?.drive || s.phase !== 'idle') return [];
    const list: Item[] = [];
    if ((s.current?.screenshots ?? 0) > 0) list.push({ type: 'shots' });
    list.push({ type: 'create' });
    for (const backup of s.backups) list.push({ type: 'restore', backup });
    return list;
  }

  handleInput(input: PanelInput): 'close' | void {
    if (input.justPressed('back')) return 'close';
    const items = this.items();
    if (items.length === 0) return;
    this.index = Math.max(0, Math.min(this.index, items.length - 1));
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action)) continue;
      const next = Math.max(0, Math.min(items.length - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.confirming = null;
        this.deps.sounds.move();
        this.render();
      }
    }
    const item = items[this.index];
    if (item?.type === 'shots' && (input.repeatPressed('left') || input.repeatPressed('right'))) this.toggleShots();
    if (input.justPressed('confirm')) void this.run(item);
  }

  hints(hint: (glyph: string, label: string) => string): string {
    const item = this.items()[this.index];
    if (!item) return hint('B', 'Voltar');
    const label = item.type === 'shots' ? 'Mudar' : item.type === 'create' ? 'Fazer backup' : 'Restaurar';
    return hint('A', label) + hint('B', 'Voltar');
  }

  private toggleShots(): void {
    this.withShots = !this.withShots;
    this.deps.sounds.move();
    this.render();
  }

  private async run(item: Item | undefined): Promise<void> {
    if (!item || this.busy) return;
    if (item.type === 'shots') return this.toggleShots();
    if (item.type === 'restore' && this.confirming !== item.backup.id) {
      this.confirming = item.backup.id;
      this.deps.sounds.error();
      this.render();
      return;
    }
    this.confirming = null;
    this.busy = true;
    this.deps.sounds.select();
    try {
      const res = await fetch(item.type === 'create' ? '/api/backup/create' : '/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.type === 'create' ? { screenshots: this.withShots } : { id: item.backup.id }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `erro ${res.status}`);
      }
      // O resultado (feito, ou o erro do pendrive) chega pelo WebSocket e aparece na tela.
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast((err as Error).message, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render(): void {
    const host = this.deps.host();
    const s = this.state();
    const head = `<h2>${icons.save} Backup no pendrive</h2>`;
    if (!s) {
      host.innerHTML = `${head}<p class="muted">Conectando ao sistema…</p>`;
      return this.deps.hintsChanged();
    }

    const drive = s.drive
      ? `<div class="upd-version"><span>Pendrive</span><b>${escapeHtml(s.drive.name)}${s.drive.freeBytes !== null ? ` · ${size(s.drive.freeBytes)} livres` : ''}</b></div>`
      : `<div class="bk-empty">${icons.insert}<div><b>Coloque um pendrive no console.</b>
          <span class="muted">Um pendrive comum (sem jogo). O backup guarda perfis, saves, tempo de jogo, conquistas e, se quiser, as capturas.</span></div></div>`;

    let status = '';
    if (s.phase !== 'idle') {
      const pct = Math.round(s.progress * 100);
      const what = s.phase === 'restoring' ? 'Restaurando… (antes, guardando no pendrive o que há agora)' : 'Copiando para o pendrive…';
      status = `<p class="upd-status">${what} ${pct}%</p><div class="upd-bar"><span style="width:${pct}%"></span></div>
        <p class="muted">Não tire o pendrive.</p>`;
    } else if (s.result?.kind === 'backup') {
      status = `<p class="upd-status ok">${icons.cartridge}Backup feito. Pode tirar o pendrive.</p>`;
    }
    if (s.error) status += `<p class="upd-error">${escapeHtml(s.error)}</p>`;

    const items = this.items();
    // O pendrive chegou (ou a cópia acabou) com a tela aberta: a seleção vai para "Fazer backup agora".
    if (this.lastCount === 0 && items.length > 0) this.index = Math.max(0, items.findIndex((i) => i.type === 'create'));
    this.lastCount = items.length;
    this.index = Math.max(0, Math.min(this.index, Math.max(0, items.length - 1)));
    const row = (item: Item, i: number): string => {
      const selected = i === this.index ? ' selected' : '';
      if (item.type === 'shots') {
        return (
          `<li class="setting-row${selected}" data-i="${i}"><span class="setting-name">Incluir as capturas</span>` +
          `<span class="setting-choice"><b>${this.withShots ? 'Sim' : 'Não'}</b></span>` +
          `<span class="setting-help">${s.current!.screenshots} captura(s), ${size(s.current!.screenshotBytes)}</span></li>`
        );
      }
      if (item.type === 'create') {
        const c = s.current;
        // current.bytes já conta as capturas; sem elas, só os saves.
        const bytes = c ? (this.withShots ? c.bytes : c.bytes - c.screenshotBytes) : 0;
        return (
          `<li class="bk-action${selected}" data-i="${i}"><span class="save-name">${icons.save} Fazer backup agora</span>` +
          `<span class="save-meta">${c ? `${summary(c, this.withShots)} · ${size(bytes)}` : ''}</span></li>`
        );
      }
      const b = item.backup;
      const confirming = this.confirming === b.id;
      return (
        `<li class="${selected.trim()}${confirming ? ' confirming' : ''}" data-i="${i}">` +
        `<span class="save-name">${formatDate(b.createdAt)}${b.reason === 'before-restore' ? ' <span class="badge">cópia automática</span>' : ''}</span>` +
        `<span class="save-meta">${
          confirming
            ? 'Aperte A de novo: os saves deste console serão trocados pelos deste backup'
            : `${escapeHtml(b.contents.profiles.map((p) => p.name).join(', ') || 'sem perfis')} · ${summary(b.contents, b.withScreenshots, false)} · Playzin ${escapeHtml(b.systemVersion)}`
        }</span></li>`
      );
    };
    const html = items.map((item, i) => ({ item, html: row(item, i) }));
    const createHtml = html.filter((x) => x.item.type !== 'restore').map((x) => x.html).join('');
    const restoreHtml = html.filter((x) => x.item.type === 'restore').map((x) => x.html).join('');
    const ready = Boolean(s.drive) && s.phase === 'idle';

    host.innerHTML =
      head +
      drive +
      status +
      (ready
        ? `<ul class="save-list bk-list">${createHtml}</ul>` +
          `<h3 class="section-title">Backups neste pendrive</h3>` +
          (restoreHtml ? `<ul class="save-list bk-list">${restoreHtml}</ul>` : `<p class="muted">Nenhum backup neste pendrive ainda.</p>`)
        : '');
    host.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
    host.querySelectorAll<HTMLElement>('[data-i]').forEach((li) =>
      li.addEventListener('click', () => {
        const i = Number(li.dataset.i);
        if (i !== this.index) {
          this.index = i;
          this.confirming = null;
          this.deps.sounds.move();
          return this.render();
        }
        void this.run(this.items()[i]);
      }),
    );
    this.deps.hintsChanged();
  }
}

/** "2 perfis · 5 jogos · 12 capturas" (sem os perfis quando os nomes já aparecem ao lado). */
export function summary(c: BackupContents, withShots: boolean, withProfiles = true): string {
  const parts = withProfiles ? [plural(c.profiles.length, 'perfil', 'perfis')] : [];
  parts.push(plural(c.games, 'jogo', 'jogos'));
  if (withShots && c.screenshots > 0) parts.push(plural(c.screenshots, 'captura', 'capturas'));
  return parts.join(' · ');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
