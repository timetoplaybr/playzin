import type { CartridgeInfo, CartridgeManifest, GameAchievements, PlaytimeEntry, PlaytimeSummary, SaveSummary, Screenshot } from '@playzin/shared';
import type { Library } from '../library';
import { formatLastPlayed, formatPlaytime, formatSessions } from '../playtime';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

interface Deps {
  store: ConsoleStore;
  library: Library;
  sounds: Sounds;
  host(): HTMLElement;
  toast(text: string, kind?: 'info' | 'error'): void;
  hintsChanged(): void;
  play(cartridge: CartridgeInfo): void;
  /** Abre o álbum já filtrado neste jogo (ao sair dele, volta para esta página). */
  openCaptures(gameId: string): void;
  /** A página fechou sozinha (jogo removido da lista, ou foi jogar). */
  closed(): void;
}

type ActionId = 'play' | 'captures' | 'delete' | 'forget';
interface Action {
  id: ActionId;
  label: string;
  icon: string;
  /** Pede um segundo A (apagar e remover não têm volta). */
  confirm?: string;
}

/** O que a página mostra, carregado do console para o perfil ativo. */
interface Details {
  playtime: PlaytimeEntry | null;
  achievements: GameAchievements | null;
  shots: Screenshot[];
  save: SaveSummary | null;
}

const MAX_SHOTS = 4;
const MAX_ACHIEVEMENTS = 6;

/**
 * Página de detalhes de um jogo, como nas lojas e bibliotecas dos consoles: capa grande, nome,
 * autor, versão, jogadores, se o cartucho está no console, a descrição e, do perfil ativo, tempo
 * de jogo, conquistas, capturas e progresso salvo. Funciona também com o cartucho fora (o console
 * guarda os dados do jogo na primeira vez que ele entra).
 *   ←/→ = ação (Jogar, Ver capturas, Apagar progresso, Remover da lista) · A = fazer
 *   ↑/↓ = rolar a página · B = voltar
 */
export class GamePage {
  private gameId: string | null = null;
  private details: Details | null = null;
  private failed = false;
  private actionIndex = 0;
  private confirming: ActionId | null = null;
  private request = 0;

  constructor(private readonly deps: Deps) {}

  get currentGame(): string | null {
    return this.gameId;
  }

  open(gameId: string): void {
    if (this.gameId !== gameId) {
      this.details = null;
      this.actionIndex = 0;
    }
    this.gameId = gameId;
    this.confirming = null;
    this.failed = false;
    void this.load();
  }

  close(): void {
    this.gameId = null;
    this.details = null;
  }

  /** O perfil mudou, acabou uma partida ou uma captura foi apagada: recarrega. */
  reload(): void {
    if (this.gameId) void this.load();
  }

  // ---------------------------------------------------------------- dados

  /** O cartucho deste jogo, se ele estiver no console agora. */
  private cartridge(): CartridgeInfo | null {
    const c = this.deps.store.get().cartridge;
    return c && c.manifest.id === this.gameId ? c : null;
  }

  /** Dados do playzin.json: do cartucho inserido ou da cópia guardada na biblioteca. */
  private manifest(): Partial<CartridgeManifest> & { id: string; name: string } {
    const c = this.cartridge();
    if (c) return c.manifest;
    const entry = this.deps.library.get(this.gameId!);
    return {
      id: this.gameId!,
      name: entry?.name ?? this.gameId!,
      version: entry?.version,
      description: entry?.description,
      author: entry?.author,
      players: entry?.players,
    };
  }

  private async load(): Promise<void> {
    const gameId = this.gameId;
    const profile = this.deps.store.profile();
    const ticket = ++this.request;
    if (!gameId) return;
    const json = <T>(url: string): Promise<T | null> =>
      fetch(url, { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
        .catch(() => null);
    const q = profile ? `?profile=${encodeURIComponent(profile.id)}` : null;
    const [playtime, achievements, shots, saves] = await Promise.all([
      q ? json<PlaytimeSummary>(`/api/playtime${q}`) : null,
      q ? json<GameAchievements>(`/api/achievements/game/${encodeURIComponent(gameId)}${q}`) : null,
      json<{ screenshots: Screenshot[] }>('/api/screenshots'),
      q ? json<{ saves: SaveSummary[] }>(`/api/saves${q}`) : null,
    ]);
    if (ticket !== this.request || this.gameId !== gameId) return; // trocou de jogo ou perfil no meio
    this.failed = !playtime && !shots && Boolean(q);
    this.details = {
      playtime: playtime?.games.find((g) => g.id === gameId) ?? null,
      achievements: achievements && achievements.total > 0 ? achievements : null,
      shots: (shots?.screenshots ?? []).filter((s) => s.game === gameId),
      save: saves?.saves.find((s) => s.id === gameId) ?? null,
    };
    const count = this.actions().length;
    if (this.actionIndex >= count) this.actionIndex = Math.max(0, count - 1);
    this.render();
  }

  private actions(): Action[] {
    const list: Action[] = [];
    if (this.cartridge()) list.push({ id: 'play', label: 'Jogar', icon: icons.play });
    if (this.details?.shots.length) list.push({ id: 'captures', label: 'Ver capturas', icon: icons.camera });
    if (this.details?.save) list.push({ id: 'delete', label: 'Apagar progresso', icon: icons.trash, confirm: 'Aperte A de novo para apagar' });
    if (!this.cartridge()) list.push({ id: 'forget', label: 'Remover da lista', icon: icons.trash, confirm: 'Aperte A de novo para remover' });
    return list;
  }

  // ---------------------------------------------------------------- input

  handleInput(input: PanelInput): 'close' | void {
    if (input.justPressed('back')) return 'close';
    const actions = this.actions();
    for (const [action, dx] of [['left', -1], ['right', 1]] as const) {
      if (!input.repeatPressed(action) || actions.length === 0) continue;
      const next = Math.max(0, Math.min(actions.length - 1, this.actionIndex + dx));
      if (next !== this.actionIndex) {
        this.actionIndex = next;
        this.confirming = null;
        this.deps.sounds.move();
        this.render();
      }
    }
    // A página pode ser mais alta que o painel: o direcional para cima/baixo rola.
    if (input.repeatPressed('up')) this.deps.host().scrollBy({ top: -110, behavior: 'smooth' });
    if (input.repeatPressed('down')) this.deps.host().scrollBy({ top: 110, behavior: 'smooth' });
    if (input.justPressed('confirm')) void this.run(actions[this.actionIndex]);
  }

  private async run(action: Action | undefined): Promise<void> {
    if (!action || !this.gameId) return;
    if (action.confirm && this.confirming !== action.id) {
      this.confirming = action.id;
      this.deps.sounds.error();
      this.render();
      return;
    }
    this.confirming = null;
    const name = this.manifest().name;
    if (action.id === 'play') {
      const cartridge = this.cartridge();
      if (!cartridge) return;
      this.deps.closed();
      this.deps.play(cartridge);
    } else if (action.id === 'captures') {
      this.deps.sounds.select();
      this.deps.openCaptures(this.gameId);
    } else if (action.id === 'delete') {
      const profile = this.deps.store.profile();
      if (!profile) return;
      try {
        const res = await fetch(`/api/saves/${encodeURIComponent(profile.id)}/${encodeURIComponent(this.gameId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(String(res.status));
        this.deps.sounds.back();
        this.deps.toast(`Progresso de “${name}” apagado`);
      } catch {
        this.deps.sounds.error();
        this.deps.toast('Não foi possível apagar', 'error');
      }
      void this.load();
    } else {
      this.deps.library.forget(this.gameId);
      this.deps.sounds.back();
      this.deps.toast(`“${name}” removido da lista`);
      this.deps.closed();
    }
  }

  hints(hint: (glyph: string, label: string) => string): string {
    const action = this.actions()[this.actionIndex];
    return (action ? hint('A', action.label) : '') + hint('↕', 'Rolar') + hint('B', 'Voltar');
  }

  // ---------------------------------------------------------------- desenho

  render(): void {
    const host = this.deps.host();
    if (!this.gameId) return;
    const m = this.manifest();
    const cartridge = this.cartridge();
    const entry = this.deps.library.get(this.gameId);
    const cover = cartridge?.coverUrl ?? entry?.cover;
    const art = cover
      ? `<img src="${escapeHtml(cover)}" alt="" draggable="false">`
      : `<span class="gp-letter" style="background:${letterColor(this.gameId)}">${escapeHtml(initials(m.name))}</span>`;
    const meta = [m.author ? `por ${escapeHtml(m.author)}` : '', m.version ? `versão ${escapeHtml(m.version)}` : '', playersLabel(m.players)]
      .filter(Boolean)
      .join(' · ');
    const status = cartridge
      ? `<p class="gp-status ok">${icons.cartridge}Cartucho no console</p>`
      : `<p class="gp-status">${icons.insert}Cartucho fora do console: insira para jogar</p>`;
    const actions = this.actions()
      .map((a, i) => {
        const confirming = this.confirming === a.id;
        const cls = ['gp-action', i === this.actionIndex ? 'selected' : '', confirming ? 'confirming' : '', a.id === 'play' ? 'primary' : ''];
        return `<button class="${cls.filter(Boolean).join(' ')}" data-action="${i}">${a.icon}<span>${confirming ? a.confirm : a.label}</span></button>`;
      })
      .join('');

    // Arte de fundo do jogo atrás do topo da página (é o único lugar onde ela aparece).
    const hasArt = cartridge ? Boolean(cartridge.hasBackground) : Boolean(entry?.background);
    const backdrop = hasArt
      ? `<div class="gp-backdrop" style="background-image:url('/api/backgrounds/${encodeURIComponent(this.gameId)}?v=${encodeURIComponent(m.version ?? '')}')"></div>`
      : '';
    host.classList.toggle('has-art', hasArt);
    host.innerHTML = `${backdrop}
      <div class="gp-head">
        <div class="gp-cover">${art}</div>
        <div class="gp-title">
          <h2 class="gp-name">${escapeHtml(m.name)}</h2>
          ${meta ? `<p class="gp-meta">${meta}</p>` : ''}
          ${status}
          <div class="gp-actions">${actions}</div>
        </div>
      </div>
      <p class="gp-desc">${m.description ? escapeHtml(m.description) : '<span class="muted">Este jogo não tem descrição.</span>'}</p>
      ${this.statsHtml()}
      ${this.achievementsHtml()}
      ${this.shotsHtml()}`;

    host.querySelectorAll<HTMLElement>('[data-action]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.action);
        if (i !== this.actionIndex) {
          this.actionIndex = i;
          this.confirming = null;
          this.deps.sounds.move();
        }
        void this.run(this.actions()[i]);
      }),
    );
    host.querySelectorAll<HTMLElement>('.gp-shot').forEach((el) =>
      el.addEventListener('click', () => this.gameId && this.deps.openCaptures(this.gameId)),
    );
    this.deps.hintsChanged();
  }

  private statsHtml(): string {
    const d = this.details;
    const profile = this.deps.store.profile();
    if (!profile) return '';
    if (!d) return `<p class="muted">Carregando…</p>`;
    if (this.failed) return `<p class="muted">Não foi possível ler os dados deste jogo agora.</p>`;
    const p = d.playtime;
    const tile = (label: string, value: string, extra = '') => `<div class="gp-stat${extra}"><span>${label}</span><b>${value}</b></div>`;
    const tiles = [
      tile('Tempo jogado', p ? formatPlaytime(p.seconds) : 'Nunca jogou'),
      tile('Partidas', p ? formatSessions(p.sessions) : '—'),
      tile('Última vez', p ? formatLastPlayed(p.lastPlayedAt) : '—'),
      d.achievements ? tile('Conquistas', `${d.achievements.unlocked} de ${d.achievements.total}`, d.achievements.unlocked === d.achievements.total ? ' complete' : '') : '',
      tile('Progresso salvo', d.save ? formatLastPlayed(d.save.updatedAt) : 'Nenhum'),
    ].join('');
    return `<h3 class="section-title">De ${escapeHtml(profile.name)}</h3><div class="gp-stats">${tiles}</div>`;
  }

  private achievementsHtml(): string {
    const a = this.details?.achievements;
    if (!a) return '';
    const shown = a.achievements.slice(0, MAX_ACHIEVEMENTS);
    const rows = shown
      .map((x) => {
        const done = Boolean(x.unlockedAt);
        return (
          `<li class="ach-row${done ? ' done' : ''}${x.hidden && !done ? ' secret' : ''}">` +
          `<span class="ach-icon">${done ? icons.trophy : icons.lockSmall}</span>` +
          `<span class="ach-name">${escapeHtml(x.name)}</span>` +
          `<span class="ach-desc">${escapeHtml(x.description)}</span>` +
          `<span class="ach-date">${done ? formatLastPlayed(x.unlockedAt!) : ''}</span></li>`
        );
      })
      .join('');
    const more = a.achievements.length - shown.length;
    return (
      `<h3 class="section-title">Conquistas · ${a.unlocked} de ${a.total}</h3>` +
      `<div class="ach-progress"><span style="width:${Math.round((a.unlocked / a.total) * 100)}%"></span></div>` +
      `<ul class="ach-list">${rows}</ul>` +
      (more > 0 ? `<p class="muted gp-more">E mais ${more === 1 ? '1 conquista' : `${more} conquistas`} em Troféus.</p>` : '')
    );
  }

  private shotsHtml(): string {
    const shots = this.details?.shots ?? [];
    if (shots.length === 0) return '';
    const thumbs = shots
      .slice(0, MAX_SHOTS)
      .map((s) => `<button class="gp-shot" title="Ver capturas"><img src="${escapeHtml(s.thumbUrl)}" alt="" loading="lazy" draggable="false"></button>`)
      .join('');
    const total = shots.length === 1 ? '1 captura' : `${shots.length} capturas`;
    return `<h3 class="section-title">Capturas · ${total}</h3><div class="gp-shots">${thumbs}</div>`;
  }
}

/** "1 jogador", "1 a 2 jogadores", ou vazio se o jogo não diz. */
export function playersLabel(players: CartridgeManifest['players'] | undefined): string {
  if (players === undefined) return '';
  if (typeof players === 'number') return players === 1 ? '1 jogador' : `${players} jogadores`;
  const [min, max] = players;
  return min === max ? `${max} jogadores` : `${min} a ${max} jogadores`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

function letterColor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 65% 40%))`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
