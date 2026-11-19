import type { GamePlaytime, PlaytimeEntry, PlaytimeSummary } from '@playzin/shared';
import type { Library } from '../library';
import { formatLastPlayed, formatPlaytime, formatSessions } from '../playtime';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import { avatarHtml, gradient } from './profiles';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

interface Deps {
  store: ConsoleStore;
  library: Library;
  sounds: Sounds;
  /** Elemento do painel (o mesmo dos outros painéis da tela inicial). */
  host(): HTMLElement;
  hintsChanged(): void;
}

/**
 * Tela "Atividade": os jogos do perfil ativo, do mais jogado para o menos jogado, com tempo,
 * vezes que abriu e a última vez. A num jogo mostra quanto cada perfil do console jogou dele.
 *   Lista:   ↑/↓ = jogo · A = ver quem jogou · B = fechar
 *   Detalhe: B = voltar para a lista
 */
export class ActivityPanel {
  private summary: PlaytimeSummary | null = null;
  private failed = false;
  private index = 0;
  private detail: GamePlaytime | null = null;
  private detailLoading: string | null = null;
  /** Evita que uma resposta atrasada (de outro perfil) apareça. */
  private request = 0;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.summary = null;
    this.failed = false;
    this.index = 0;
    this.detail = null;
    this.detailLoading = null;
    void this.load();
  }

  /** O perfil ativo mudou ou acabou uma partida: recarrega mantendo o jogo em foco. */
  reload(): void {
    const focused = this.summary?.games[this.index]?.id;
    void this.load(focused);
    if (this.detail) void this.openDetail(this.detail.id, false);
  }

  private async load(keepId?: string): Promise<void> {
    const profile = this.deps.store.profile();
    const ticket = ++this.request;
    try {
      if (!profile) throw new Error('sem perfil');
      const res = await fetch(`/api/playtime?profile=${encodeURIComponent(profile.id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const summary = (await res.json()) as PlaytimeSummary;
      if (ticket !== this.request) return;
      this.summary = summary;
      this.failed = false;
      const kept = keepId ? summary.games.findIndex((g) => g.id === keepId) : -1;
      this.index = kept >= 0 ? kept : Math.min(this.index, Math.max(0, summary.games.length - 1));
    } catch {
      if (ticket !== this.request) return;
      this.summary = { totalSeconds: 0, games: [] };
      this.failed = true;
    }
    this.render();
  }

  private async openDetail(gameId: string, withSound = true): Promise<void> {
    if (withSound) this.deps.sounds.select();
    this.detailLoading = gameId;
    if (!this.detail || this.detail.id !== gameId) this.render();
    try {
      const res = await fetch(`/api/playtime/game/${encodeURIComponent(gameId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const detail = (await res.json()) as GamePlaytime;
      if (this.detailLoading !== gameId) return; // voltou antes de chegar
      this.detail = detail;
    } catch {
      if (this.detailLoading !== gameId) return;
      this.detailLoading = null;
      this.deps.sounds.error();
      this.render();
      return;
    }
    this.detailLoading = null;
    this.render();
  }

  private closeDetail(): void {
    this.detail = null;
    this.detailLoading = null;
    this.deps.sounds.back();
    this.render();
  }

  private get inDetail(): boolean {
    return this.detail !== null || this.detailLoading !== null;
  }

  // ------------------------------------------------------------ desenho

  render(): void {
    const host = this.deps.host();
    host.innerHTML = this.inDetail ? this.detailHtml() : this.listHtml();
    host.querySelectorAll<HTMLElement>('.act-game').forEach((li) =>
      li.addEventListener('click', () => {
        const index = Number(li.dataset.index);
        if (index !== this.index) {
          this.index = index;
          this.deps.sounds.move();
        }
        const game = this.summary?.games[index];
        if (game) void this.openDetail(game.id);
      }),
    );
    host.querySelector('.act-back')?.addEventListener('click', () => this.closeDetail());
    host.querySelector('.act-game.selected')?.scrollIntoView({ block: 'nearest' });
    this.deps.hintsChanged();
  }

  private listHtml(): string {
    const profile = this.deps.store.profile();
    const title = `<h2>${icons.activity} Atividade${profile ? ` de ${escapeHtml(profile.name)}` : ''}</h2>`;
    if (!this.summary) return `${title}<p class="muted">Carregando…</p>`;
    if (this.failed) return `${title}<p class="muted">Não foi possível ler o tempo de jogo agora.</p>`;
    const games = this.summary.games;
    if (games.length === 0) {
      return `${title}<p class="muted">Nenhum jogo ainda. O tempo começa a contar na primeira partida.</p>`;
    }
    const top = games[0].seconds;
    const rows = games
      .map((g, i) => {
        const share = Math.max(4, Math.round((g.seconds / top) * 100));
        return (
          `<li class="act-game${i === this.index ? ' selected' : ''}" data-index="${i}">` +
          this.coverHtml(g) +
          `<span class="act-name">${escapeHtml(g.name)}</span>` +
          `<span class="act-time">${formatPlaytime(g.seconds)}</span>` +
          `<span class="act-bar"><span style="width:${share}%"></span></span>` +
          `<span class="act-meta">${formatSessions(g.sessions)} · ${formatLastPlayed(g.lastPlayedAt)}</span>` +
          `</li>`
        );
      })
      .join('');
    const count = games.length === 1 ? '1 jogo' : `${games.length} jogos`;
    return (
      `${title}<p class="act-summary">${icons.clock}<b>${formatPlaytime(this.summary.totalSeconds)}</b> no total · ${count}</p>` +
      `<ul class="act-list">${rows}</ul>`
    );
  }

  private detailHtml(): string {
    const id = this.detail?.id ?? this.detailLoading!;
    const listed = this.summary?.games.find((g) => g.id === id);
    const name = this.detail?.name ?? listed?.name ?? id;
    const head =
      `<h2><button class="act-back" title="Voltar">${icons.chevronLeft}</button>` +
      `${listed ? this.coverHtml(listed) : ''}<span class="act-title">${escapeHtml(name)}</span></h2>`;
    if (!this.detail) return `${head}<p class="muted">Carregando…</p>`;

    const profiles = this.deps.store.get().profiles ?? [];
    const byProfile = new Map(this.detail.players.map((p) => [p.profile, p]));
    // Quem jogou primeiro (mais tempo antes), depois quem ainda não jogou.
    const ordered = [
      ...this.detail.players.map((p) => profiles.find((x) => x.id === p.profile)).filter((p) => p !== undefined),
      ...profiles.filter((p) => !byProfile.has(p.id)),
    ];
    const top = this.detail.players[0]?.seconds ?? 1;
    const activeId = this.deps.store.get().profileId;
    const rows = ordered
      .map((p) => {
        const stats = byProfile.get(p.id);
        const share = stats ? Math.max(4, Math.round((stats.seconds / top) * 100)) : 0;
        return (
          `<li class="act-player${stats ? '' : ' idle'}${p.id === activeId ? ' me' : ''}">` +
          avatarHtml(p, 'act-avatar') +
          `<span class="act-name">${escapeHtml(p.name)}${p.id === activeId ? ' <small>(você)</small>' : ''}</span>` +
          `<span class="act-time">${stats ? formatPlaytime(stats.seconds) : 'Não jogou'}</span>` +
          `<span class="act-bar"><span style="width:${share}%;background:${gradient(p.color)}"></span></span>` +
          `<span class="act-meta">${stats ? `${formatSessions(stats.sessions)} · ${formatLastPlayed(stats.lastPlayedAt)}` : ''}</span>` +
          `</li>`
        );
      })
      .join('');
    const players = this.detail.players.length;
    return (
      head +
      `<p class="act-summary">${icons.clock}<b>${formatPlaytime(this.detail.totalSeconds)}</b> no console · ` +
      `${players === 1 ? '1 pessoa jogou' : `${players} pessoas jogaram`}</p>` +
      `<ul class="act-list">${rows}</ul>`
    );
  }

  private coverHtml(game: PlaytimeEntry): string {
    const cover = this.deps.library.get(game.id)?.cover;
    if (cover) return `<img class="act-cover" src="${escapeHtml(cover)}" alt="" draggable="false">`;
    return `<span class="act-cover act-cover-letter" style="background:${letterColor(game.id)}">${escapeHtml(
      [...game.name.trim()][0]?.toUpperCase() ?? '?',
    )}</span>`;
  }

  // ------------------------------------------------------------ input

  handleInput(input: PanelInput): 'close' | void {
    if (this.inDetail) {
      if (input.justPressed('back')) this.closeDetail();
      return;
    }
    if (input.justPressed('back')) return 'close';
    const count = this.summary?.games.length ?? 0;
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action) || count === 0) continue;
      const next = Math.max(0, Math.min(count - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.deps.sounds.move();
        this.render();
      }
    }
    if (input.justPressed('confirm')) {
      const game = this.summary?.games[this.index];
      if (game) void this.openDetail(game.id);
    }
  }

  hints(hint: (glyph: string, label: string) => string): string {
    if (this.inDetail) return hint('B', 'Voltar');
    return (this.summary?.games.length ? hint('A', 'Quem jogou') : '') + hint('B', 'Voltar');
  }
}

/** Cor fixa por jogo para a capa de letra (quando o console não tem a capa guardada). */
function letterColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 65% 40%))`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
