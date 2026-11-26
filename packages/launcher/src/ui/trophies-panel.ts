import type { AchievementsSummary, GameAchievements } from '@playzin/shared';
import type { Library } from '../library';
import { formatLastPlayed } from '../playtime';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import { avatarHtml } from './profiles';
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

type SummaryGame = AchievementsSummary['games'][number];
type Filter = 'all' | 'unlocked' | 'locked';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'unlocked', label: 'Desbloqueadas' },
  { id: 'locked', label: 'Bloqueadas' },
];

/**
 * Tela "Conquistas": só as conquistas do perfil ativo, jogo por jogo.
 *   Lista:   resumo do perfil, as últimas desbloqueadas e os jogos (mais recente primeiro).
 *            ↑/↓ = jogo · A = abrir · B = fechar
 *   Jogo:    as conquistas do jogo. ↑/↓ = conquista · Y = filtro (todas/desbloqueadas/bloqueadas) · B = voltar
 * Os jogos aparecem mesmo com o cartucho fora (o console guarda a lista de cada um).
 */
export class TrophiesPanel {
  private summary: AchievementsSummary | null = null;
  private failed = false;
  private index = 0;
  private detail: GameAchievements | null = null;
  private detailLoading: string | null = null;
  private detailIndex = 0;
  private filter: Filter = 'all';
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
    const focused = this.games()[this.index]?.id;
    void this.load(focused);
    if (this.detail) void this.openDetail(this.detail.id, false);
  }

  /** Jogos em ordem: quem desbloqueou por último primeiro; os sem nenhuma, por nome. */
  private games(): SummaryGame[] {
    const games = [...(this.summary?.games ?? [])];
    return games.sort((a, b) => {
      if (a.lastUnlockedAt && b.lastUnlockedAt) return b.lastUnlockedAt.localeCompare(a.lastUnlockedAt);
      if (a.lastUnlockedAt || b.lastUnlockedAt) return a.lastUnlockedAt ? -1 : 1;
      return a.name.localeCompare(b.name, 'pt-BR');
    });
  }

  private async load(keepId?: string): Promise<void> {
    const profile = this.deps.store.profile();
    const ticket = ++this.request;
    try {
      if (!profile) throw new Error('sem perfil');
      const res = await fetch(`/api/achievements?profile=${encodeURIComponent(profile.id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const summary = (await res.json()) as AchievementsSummary;
      if (ticket !== this.request) return;
      this.summary = { games: summary.games ?? [], recent: summary.recent ?? [] };
      this.failed = false;
      const games = this.games();
      const kept = keepId ? games.findIndex((g) => g.id === keepId) : -1;
      this.index = kept >= 0 ? kept : Math.min(this.index, Math.max(0, games.length - 1));
    } catch {
      if (ticket !== this.request) return;
      this.summary = { games: [], recent: [] };
      this.failed = true;
    }
    this.render();
  }

  private async openDetail(gameId: string, fresh = true): Promise<void> {
    const profile = this.deps.store.profile();
    if (!profile) return;
    if (fresh) {
      this.deps.sounds.select();
      this.detailIndex = 0;
      this.filter = 'all';
    }
    this.detailLoading = gameId;
    if (!this.detail || this.detail.id !== gameId) this.render();
    try {
      const url = `/api/achievements/game/${encodeURIComponent(gameId)}?profile=${encodeURIComponent(profile.id)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const detail = (await res.json()) as GameAchievements;
      if (this.detailLoading !== gameId) return; // voltou antes de chegar
      this.detail = detail;
      this.detailIndex = Math.min(this.detailIndex, Math.max(0, this.visible().length - 1));
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

  /** As conquistas do jogo aberto que passam no filtro (desbloqueadas mais novas primeiro). */
  private visible(): GameAchievements['achievements'] {
    const list = this.detail?.achievements ?? [];
    if (this.filter === 'unlocked') return list.filter((a) => a.unlockedAt);
    if (this.filter === 'locked') return list.filter((a) => !a.unlockedAt);
    return list;
  }

  private nextFilter(): void {
    const i = FILTERS.findIndex((f) => f.id === this.filter);
    this.filter = FILTERS[(i + 1) % FILTERS.length]!.id;
    this.detailIndex = 0;
    this.deps.sounds.move();
    this.render();
    this.deps.host().scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------ desenho

  render(): void {
    const host = this.deps.host();
    host.innerHTML = this.inDetail ? this.detailHtml() : this.listHtml();
    host.querySelectorAll<HTMLElement>('.tro-game').forEach((li) =>
      li.addEventListener('click', () => {
        const index = Number(li.dataset.index);
        if (index !== this.index) {
          this.index = index;
          this.deps.sounds.move();
        }
        const game = this.games()[index];
        if (game) void this.openDetail(game.id);
      }),
    );
    host.querySelectorAll<HTMLElement>('.tro-ach').forEach((li) =>
      li.addEventListener('click', () => {
        const index = Number(li.dataset.index);
        if (index === this.detailIndex) return;
        this.detailIndex = index;
        this.deps.sounds.move();
        this.render();
      }),
    );
    host.querySelectorAll<HTMLElement>('.tro-filter').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.filter === this.filter) return;
        this.filter = b.dataset.filter as Filter;
        this.detailIndex = 0;
        this.deps.sounds.move();
        this.render();
      }),
    );
    host.querySelector('.act-back')?.addEventListener('click', () => this.closeDetail());
    // No primeiro item, volta ao topo: senão o cabeçalho acima dele (resumo, filtros) fica escondido.
    const selected = host.querySelector<HTMLElement>('.tro-game.selected, .tro-ach.selected');
    if (selected?.dataset.index === '0') host.scrollTo({ top: 0 });
    else selected?.scrollIntoView({ block: 'nearest' });
    this.deps.hintsChanged();
  }

  private listHtml(): string {
    const profile = this.deps.store.profile();
    const title = `<h2>${icons.trophy} Conquistas</h2>`;
    if (!this.summary) return `${title}<p class="muted">Carregando…</p>`;
    if (this.failed) return `${title}<p class="muted">Não foi possível ler as conquistas agora.</p>`;
    const games = this.games();
    if (games.length === 0) {
      return (
        `${title}<p class="muted">Nenhum jogo com conquistas ainda. Quando um cartucho com conquistas entrar ` +
        `no console, ele aparece aqui.</p>`
      );
    }

    const unlocked = games.reduce((n, g) => n + g.unlocked, 0);
    const total = games.reduce((n, g) => n + g.total, 0);
    const complete = games.filter((g) => g.unlocked === g.total).length;
    const overview =
      `<div class="tro-overview">` +
      (profile ? avatarHtml(profile, 'tro-avatar') : '') +
      `<div class="tro-overview-text">` +
      `<span class="tro-profile">${profile ? escapeHtml(profile.name) : ''}</span>` +
      `<span class="tro-total"><b>${unlocked}</b> de ${total} conquistas</span>` +
      `<div class="ach-progress tro-progress"><span style="width:${percent(unlocked, total)}%"></span></div>` +
      `</div>` +
      `<div class="tro-stats">` +
      stat(`${percent(unlocked, total)}%`, 'do total') +
      stat(String(games.length), games.length === 1 ? 'jogo' : 'jogos') +
      stat(String(complete), complete === 1 ? 'completo' : 'completos', complete > 0) +
      `</div></div>`;

    const recent = this.summary.recent;
    const recentHtml = recent.length
      ? `<h3 class="section-title">Recentes</h3><ul class="tro-recent">` +
        recent
          .map(
            (r) =>
              `<li title="${escapeHtml(r.description)}">` +
              `<span class="ach-icon">${icons.trophy}</span>` +
              `<span class="tro-recent-name">${escapeHtml(r.name)}</span>` +
              `<span class="tro-recent-meta">${formatLastPlayed(r.unlockedAt)} · ${escapeHtml(r.gameName)}</span>` +
              `</li>`,
          )
          .join('') +
        `</ul>`
      : '';

    const rows = games
      .map((g, i) => {
        const done = g.unlocked === g.total;
        return (
          `<li class="act-game tro-game${i === this.index ? ' selected' : ''}${done ? ' complete' : ''}" data-index="${i}">` +
          this.coverHtml(g.id, g.name) +
          `<span class="act-name">${escapeHtml(g.name)}</span>` +
          `<span class="tro-pct">${done ? `${icons.trophy} ` : ''}${percent(g.unlocked, g.total)}%</span>` +
          `<div class="ach-progress tro-bar"><span style="width:${percent(g.unlocked, g.total)}%"></span></div>` +
          `<span class="act-meta">${g.unlocked} de ${g.total}` +
          (g.lastUnlockedAt ? ` · última ${formatLastPlayed(g.lastUnlockedAt).toLowerCase()}` : ' · nenhuma ainda') +
          (done ? ' · <b class="tro-done">Completo</b>' : '') +
          `</span></li>`
        );
      })
      .join('');

    return `${title}${overview}${recentHtml}<h3 class="section-title">Jogos</h3><ul class="act-list">${rows}</ul>`;
  }

  private detailHtml(): string {
    const id = this.detail?.id ?? this.detailLoading!;
    const listed = this.summary?.games.find((g) => g.id === id);
    const name = this.detail?.name ?? listed?.name ?? id;
    const head =
      `<h2><button class="act-back" title="Voltar">${icons.chevronLeft}</button>` +
      `${this.coverHtml(id, name)}<span class="act-title">${escapeHtml(name)}</span></h2>`;
    if (!this.detail) return `${head}<p class="muted">Carregando…</p>`;

    const d = this.detail;
    const done = d.total > 0 && d.unlocked === d.total;
    const filters = FILTERS.map((f) => {
      const n = f.id === 'all' ? d.total : f.id === 'unlocked' ? d.unlocked : d.total - d.unlocked;
      return `<button class="tro-filter${f.id === this.filter ? ' active' : ''}" data-filter="${f.id}">${f.label} <small>${n}</small></button>`;
    }).join('');

    const list = this.visible();
    const rows = list.length
      ? list
          .map((a, i) => {
            const got = Boolean(a.unlockedAt);
            return (
              `<li class="ach-row tro-ach${got ? ' done' : ''}${a.hidden && !got ? ' secret' : ''}${i === this.detailIndex ? ' selected' : ''}" data-index="${i}">` +
              `<span class="ach-icon">${got ? icons.trophy : icons.lockSmall}</span>` +
              `<span class="ach-name">${escapeHtml(a.name)}</span>` +
              `<span class="ach-desc">${escapeHtml(a.description)}</span>` +
              `<span class="ach-date">${got ? formatLastPlayed(a.unlockedAt!) : ''}</span>` +
              `</li>`
            );
          })
          .join('')
      : `<li class="muted tro-empty">${this.filter === 'unlocked' ? 'Nenhuma desbloqueada ainda.' : 'Todas desbloqueadas!'}</li>`;

    return (
      head +
      `<div class="tro-game-summary">` +
      `<span class="tro-total"><b>${d.unlocked}</b> de ${d.total} conquistas${done ? ' · <b class="tro-done">Completo</b>' : ''}</span>` +
      `<span class="tro-pct">${percent(d.unlocked, d.total)}%</span>` +
      `</div>` +
      `<div class="ach-progress"><span style="width:${percent(d.unlocked, d.total)}%"></span></div>` +
      `<div class="tro-filters">${filters}</div>` +
      `<ul class="ach-list">${rows}</ul>`
    );
  }

  private coverHtml(id: string, name: string): string {
    const cover = this.deps.library.get(id)?.cover;
    if (cover) return `<img class="act-cover" src="${escapeHtml(cover)}" alt="" draggable="false">`;
    return `<span class="act-cover act-cover-letter" style="background:${letterColor(id)}">${escapeHtml(
      [...name.trim()][0]?.toUpperCase() ?? '?',
    )}</span>`;
  }

  // ------------------------------------------------------------ input

  handleInput(input: PanelInput): 'close' | void {
    if (this.inDetail) {
      if (input.justPressed('back')) return void this.closeDetail();
      if (!this.detail) return;
      if (input.justPressed('special')) return void this.nextFilter();
      const count = this.visible().length;
      for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
        if (!input.repeatPressed(action) || count === 0) continue;
        const next = Math.max(0, Math.min(count - 1, this.detailIndex + dy));
        if (next !== this.detailIndex) {
          this.detailIndex = next;
          this.deps.sounds.move();
          this.render();
        }
      }
      return;
    }
    if (input.justPressed('back')) return 'close';
    const games = this.games();
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action) || games.length === 0) continue;
      const next = Math.max(0, Math.min(games.length - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.deps.sounds.move();
        this.render();
      }
    }
    if (input.justPressed('confirm')) {
      const game = games[this.index];
      if (game) void this.openDetail(game.id);
    }
  }

  hints(hint: (glyph: string, label: string) => string): string {
    if (this.inDetail) {
      const next = FILTERS[(FILTERS.findIndex((f) => f.id === this.filter) + 1) % FILTERS.length]!;
      return (this.detail ? hint('Y', `Mostrar: ${next.label.toLowerCase()}`) : '') + hint('B', 'Voltar');
    }
    return (this.games().length ? hint('A', 'Ver conquistas') : '') + hint('B', 'Voltar');
  }
}

function percent(n: number, total: number): number {
  return total > 0 ? Math.floor((n / total) * 100) : 0;
}

function stat(value: string, label: string, gold = false): string {
  return `<span class="tro-stat${gold ? ' gold' : ''}"><b>${value}</b><small>${label}</small></span>`;
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
