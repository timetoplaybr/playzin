import type { Screenshot } from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import { avatarHtml } from './profiles';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

interface Deps {
  store: ConsoleStore;
  sounds: Sounds;
  /** Elemento do painel (o mesmo dos outros painéis da tela inicial). */
  host(): HTMLElement;
  toast(text: string, kind?: 'info' | 'error'): void;
  hintsChanged(): void;
}

const COLUMNS = 4;

/**
 * Tela "Capturas": o álbum do console, das mais novas para as mais antigas.
 *   Grade: direcional = escolher · A = ver · X (duas vezes) = apagar · Y = filtrar por jogo · B = fechar
 *   Foto:  ←/→ = anterior/próxima · X (duas vezes) = apagar · B = voltar para a grade
 */
export class CapturesPanel {
  private shots: Screenshot[] | null = null;
  private failed = false;
  private index = 0;
  private viewing = false;
  /** Jogo do filtro (null = todos). */
  private game: string | null = null;
  private confirmDelete: string | null = null;
  private deleting = false;

  constructor(private readonly deps: Deps) {}

  /** `game`: abre já filtrado neste jogo (a página de detalhes do jogo usa). */
  open(game: string | null = null): void {
    this.shots = null;
    this.failed = false;
    this.index = 0;
    this.viewing = false;
    this.game = game;
    this.confirmDelete = null;
    void this.load();
  }

  close(): void {
    this.deps.host().classList.remove('viewing');
  }

  private async load(keepId?: string): Promise<void> {
    try {
      const res = await fetch('/api/screenshots', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      this.shots = ((await res.json()) as { screenshots: Screenshot[] }).screenshots;
      this.failed = false;
    } catch {
      this.shots = [];
      this.failed = true;
    }
    if (this.game && !this.shots.some((s) => s.game === this.game)) this.game = null;
    const list = this.visible;
    const kept = keepId ? list.findIndex((s) => s.id === keepId) : -1;
    this.index = kept >= 0 ? kept : clamp(this.index, 0, Math.max(0, list.length - 1));
    if (list.length === 0) this.viewing = false;
    this.render();
  }

  /** Capturas do filtro atual. */
  private get visible(): Screenshot[] {
    const all = this.shots ?? [];
    return this.game ? all.filter((s) => s.game === this.game) : all;
  }

  /** Jogos do álbum, do capturado mais recentemente para o mais antigo. */
  private get games(): { id: string; name: string }[] {
    const seen = new Map<string, string>();
    for (const s of this.shots ?? []) if (!seen.has(s.game)) seen.set(s.game, s.gameName);
    return [...seen].map(([id, name]) => ({ id, name }));
  }

  // ------------------------------------------------------------ desenho

  render(): void {
    const host = this.deps.host();
    host.classList.toggle('viewing', this.viewing);
    host.innerHTML = this.viewing ? this.viewerHtml() : this.gridHtml();
    host.querySelectorAll<HTMLElement>('.shot').forEach((li) =>
      li.addEventListener('click', () => {
        const i = Number(li.dataset.index);
        if (i !== this.index) {
          this.index = i;
          this.confirmDelete = null;
          this.deps.sounds.move();
        }
        this.openViewer();
      }),
    );
    host.querySelector('.shot-filter')?.addEventListener('click', () => this.nextFilter());
    host.querySelector('.act-back')?.addEventListener('click', () => this.closeViewer());
    host.querySelector('.shot-prev')?.addEventListener('click', () => this.step(-1));
    host.querySelector('.shot-next')?.addEventListener('click', () => this.step(1));
    host.querySelector('.shot-delete')?.addEventListener('click', () => void this.deleteSelected());
    host.querySelector('.shot.selected')?.scrollIntoView({ block: 'nearest' });
    this.deps.hintsChanged();
  }

  private gridHtml(): string {
    const total = this.shots?.length ?? 0;
    const title = `<h2>${icons.camera} Capturas${total ? ` <span class="shot-count">${total}</span>` : ''}</h2>`;
    if (!this.shots) return `${title}<p class="muted">Carregando…</p>`;
    if (this.failed) return `${title}<p class="muted">Não foi possível abrir o álbum agora.</p>`;
    if (total === 0) {
      return (
        `${title}<p class="muted">Nenhuma captura ainda. Durante o jogo, aperte <b>View + RB</b> no controle ` +
        `(ou <b>F8</b> / <b>Print Screen</b> no teclado), ou escolha <b>Capturar tela</b> no menu rápido.</p>`
      );
    }
    const gameName = this.game ? this.games.find((g) => g.id === this.game)?.name ?? this.game : null;
    const filter =
      this.games.length > 1
        ? `<button class="shot-filter">${gameName ? escapeHtml(gameName) : 'Todos os jogos'}<span class="glyph">Y</span></button>`
        : '';
    const cells = this.visible
      .map((s, i) => {
        const confirming = this.confirmDelete === s.id;
        return (
          `<li class="shot${i === this.index ? ' selected' : ''}${confirming ? ' confirming' : ''}" data-index="${i}">` +
          `<img src="${escapeHtml(s.thumbUrl)}" alt="" loading="lazy" draggable="false">` +
          `<span class="shot-label">${confirming ? 'Aperte X de novo para apagar' : `${this.game ? '' : `${escapeHtml(s.gameName)} · `}${formatShotDate(s.takenAt, true)}`}</span>` +
          `</li>`
        );
      })
      .join('');
    return `<div class="shot-head">${title}${filter}</div><ul class="shot-grid">${cells}</ul>`;
  }

  private viewerHtml(): string {
    const list = this.visible;
    const s = list[this.index];
    if (!s) return '';
    const profile = (this.deps.store.get().profiles ?? []).find((p) => p.id === s.profile);
    const confirming = this.confirmDelete === s.id;
    const who = profile ? `<span class="shot-who">${avatarHtml(profile, 'shot-avatar')}${escapeHtml(profile.name)}</span>` : '';
    return (
      `<h2><button class="act-back" title="Voltar">${icons.chevronLeft}</button><span class="act-title">${escapeHtml(s.gameName)}</span>` +
      `<span class="shot-pos">${this.index + 1} de ${list.length}</span></h2>` +
      `<div class="shot-view">` +
      `<button class="shot-nav shot-prev" title="Anterior"${this.index === 0 ? ' disabled' : ''}>${icons.chevronLeft}</button>` +
      `<img src="${escapeHtml(s.url)}" alt="Captura de ${escapeHtml(s.gameName)}" draggable="false">` +
      `<button class="shot-nav shot-next" title="Próxima"${this.index >= list.length - 1 ? ' disabled' : ''}>${icons.chevronLeft}</button>` +
      `</div>` +
      `<div class="shot-caption${confirming ? ' confirming' : ''}">` +
      (confirming
        ? '<span>Aperte X de novo para apagar esta captura</span>'
        : `${who}<span>${formatShotDate(s.takenAt, false)}</span><span>${s.width}×${s.height} · ${formatBytes(s.bytes)}</span>`) +
      `<button class="shot-delete" title="Apagar">${icons.trash}</button>` +
      `</div>`
    );
  }

  /** Só troca o destaque (sem redesenhar a grade, que recarregaria as miniaturas). */
  private select(next: number): void {
    const count = this.visible.length;
    next = clamp(next, 0, count - 1);
    if (next === this.index || count === 0) return;
    this.index = next;
    this.deps.sounds.move();
    if (this.viewing || this.confirmDelete) {
      this.confirmDelete = null;
      return this.render();
    }
    const host = this.deps.host();
    host.querySelectorAll<HTMLElement>('.shot').forEach((li) => li.classList.toggle('selected', Number(li.dataset.index) === next));
    host.querySelector('.shot.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private openViewer(): void {
    if (!this.visible[this.index]) return;
    this.viewing = true;
    this.confirmDelete = null;
    this.deps.sounds.select();
    this.render();
  }

  private closeViewer(): void {
    this.viewing = false;
    this.confirmDelete = null;
    this.deps.sounds.back();
    this.render();
  }

  private step(delta: number): void {
    this.select(this.index + delta);
  }

  /** Y: Todos os jogos → jogo 1 → jogo 2 → … → Todos. */
  private nextFilter(): void {
    const games = this.games;
    if (games.length < 2) return;
    const at = this.game ? games.findIndex((g) => g.id === this.game) : -1;
    this.game = at + 1 < games.length ? games[at + 1]!.id : null;
    this.index = 0;
    this.confirmDelete = null;
    this.deps.sounds.select();
    this.render();
  }

  /** X: o primeiro aperto pede confirmação, o segundo apaga. */
  private async deleteSelected(): Promise<void> {
    const shot = this.visible[this.index];
    if (!shot || this.deleting) return;
    if (this.confirmDelete !== shot.id) {
      this.confirmDelete = shot.id;
      this.deps.sounds.error();
      this.render();
      return;
    }
    this.confirmDelete = null;
    this.deleting = true;
    try {
      const res = await fetch(`/api/screenshots/${encodeURIComponent(shot.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      this.deps.sounds.back();
      this.deps.toast('Captura apagada');
    } catch {
      this.deps.sounds.error();
      this.deps.toast('Não foi possível apagar a captura', 'error');
    } finally {
      this.deleting = false;
    }
    // Fica na mesma posição: a próxima foto ocupa o lugar da apagada.
    await this.load();
  }

  // ------------------------------------------------------------ input

  handleInput(input: PanelInput): 'close' | void {
    if (this.viewing) {
      if (input.justPressed('back')) return this.closeViewer();
      if (input.repeatPressed('left')) this.step(-1);
      if (input.repeatPressed('right')) this.step(1);
      if (input.justPressed('action')) void this.deleteSelected();
      return;
    }
    if (input.justPressed('back')) return 'close';
    if (!this.visible.length) return;
    if (input.repeatPressed('left')) this.select(this.index - 1);
    if (input.repeatPressed('right')) this.select(this.index + 1);
    if (input.repeatPressed('up') && this.index >= COLUMNS) this.select(this.index - COLUMNS);
    const lastRow = Math.floor((this.visible.length - 1) / COLUMNS);
    if (input.repeatPressed('down') && Math.floor(this.index / COLUMNS) < lastRow) {
      // Última linha incompleta: desce para a última foto.
      this.select(Math.min(this.index + COLUMNS, this.visible.length - 1));
    }
    if (input.justPressed('confirm')) this.openViewer();
    if (input.justPressed('action')) void this.deleteSelected();
    if (input.justPressed('special')) this.nextFilter();
  }

  hints(hint: (glyph: string, label: string) => string): string {
    if (this.viewing) return hint('←→', 'Anterior/próxima') + hint('X', 'Apagar') + hint('B', 'Voltar');
    if (!this.visible.length) return hint('B', 'Voltar');
    return (
      hint('A', 'Ver') +
      hint('X', 'Apagar') +
      (this.games.length > 1 ? hint('Y', 'Filtrar por jogo') : '') +
      hint('B', 'Voltar')
    );
  }
}

function formatShotDate(iso: string, short: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Hoje, ${time}`;
  const date = d.toLocaleDateString('pt-BR', short ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
  return short ? date : `${date}, ${time}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
