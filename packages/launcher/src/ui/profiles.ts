import {
  MAX_PROFILES,
  PROFILE_COLORS,
  PROFILE_ICONS,
  PROFILE_NAME_MAX,
  type Profile,
  type ProfileColor,
  type ProfileIcon,
} from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { icons, profileIcons } from './icons';
import type { VirtualKeyboard } from './keyboard';
import { formatPlaytime } from '../playtime';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

/** Gradiente de cada cor de perfil. */
export const PROFILE_GRADIENTS: Record<ProfileColor, [string, string]> = {
  coral: ['#ff9f43', '#ff5e7e'],
  ocean: ['#00c8f0', '#3a6df0'],
  forest: ['#3fcf6b', '#118a5a'],
  grape: ['#b06bff', '#6a3ff0'],
  sunny: ['#ffd23f', '#ff8f1c'],
  mint: ['#5ef2d0', '#1fa7a0'],
  rose: ['#ff7eb6', '#d63a8a'],
  slate: ['#8a94a6', '#4a5263'],
};

export const COLOR_NAMES: Record<ProfileColor, string> = {
  coral: 'Coral',
  ocean: 'Oceano',
  forest: 'Floresta',
  grape: 'Uva',
  sunny: 'Sol',
  mint: 'Menta',
  rose: 'Rosa',
  slate: 'Grafite',
};

const ICON_NAMES: Record<ProfileIcon, string> = {
  star: 'Estrela',
  heart: 'Coração',
  bolt: 'Raio',
  moon: 'Lua',
  sun: 'Sol',
  leaf: 'Folha',
  music: 'Música',
  rocket: 'Foguete',
  crown: 'Coroa',
  cat: 'Gato',
  paw: 'Patinha',
  flower: 'Flor',
};

export function gradient(color: ProfileColor): string {
  const [a, b] = PROFILE_GRADIENTS[color] ?? PROFILE_GRADIENTS.coral;
  return `linear-gradient(135deg, ${a}, ${b})`;
}

/** Círculo do avatar (ícone sobre o gradiente da cor). */
export function avatarHtml(p: { icon: ProfileIcon; color: ProfileColor }, extraClass = ''): string {
  return `<div class="pf-avatar ${extraClass}" style="background:${gradient(p.color)}">${profileIcons[p.icon] ?? icons.user}</div>`;
}

type EditorRow = 'name' | 'icon' | 'color' | 'save' | 'delete';

interface Draft {
  /** null = perfil novo */
  id: string | null;
  name: string;
  icon: ProfileIcon;
  color: ProfileColor;
}

interface Deps {
  store: ConsoleStore;
  sounds: Sounds;
  keyboard: VirtualKeyboard;
  toast(text: string, kind?: 'info' | 'error'): void;
  /** Alguém escolheu um perfil para jogar. */
  choose(profile: Profile): void;
  /** O usuário fechou a tela (B) com um perfil já ativo. */
  close(): void;
  /** Prévia do tema do menu numa cor; null volta ao tema do perfil ativo. */
  previewTheme(color: ProfileColor | null): void;
  hintsChanged(): void;
}

/**
 * Tela "Quem vai jogar?" e o editor de perfil, por cima do menu.
 *   Escolha:  ←/→ = perfil · A = jogar com ele · X = editar · B = voltar (se já houver alguém jogando)
 *   Editor:   ↑/↓ = campo · ←/→ = trocar ícone/cor · A = digitar nome / salvar / excluir · B = voltar
 */
export class ProfileScreen {
  private readonly el: HTMLDivElement;
  private view: 'closed' | 'picker' | 'editor' = 'closed';
  private pickIndex = 0;
  private draft: Draft | null = null;
  private rows: EditorRow[] = [];
  private rowIndex = 0;
  private confirmDelete = false;
  private busy = false;
  /** Elementos da vista atual, para só atualizar o que muda (sem piscar). */
  private dom: Record<string, HTMLElement> = {};
  /** Tempo total jogado por perfil (segundos). */
  private totals: Record<string, number> = {};

  constructor(
    host: HTMLElement,
    private readonly deps: Deps,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'pf-screen';
    this.el.hidden = true;
    host.append(this.el);
  }

  get isOpen(): boolean {
    return this.view !== 'closed';
  }

  get isEditing(): boolean {
    return this.view === 'editor';
  }

  private profiles(): Profile[] {
    return this.deps.store.get().profiles ?? [];
  }

  /** Pode fechar com B? Só se alguém já estiver jogando. */
  private canClose(): boolean {
    const { profileId } = this.deps.store.get();
    return Boolean(profileId && this.profiles().some((p) => p.id === profileId));
  }

  /**
   * Abre a escolha de perfil (sem nenhum perfil, já abre a criação do primeiro).
   * O foco começa em quem está jogando, ou em quem jogou por último.
   */
  openPicker(focusId?: string | null, preferFocus = false): void {
    if (this.profiles().length === 0) return this.openEditor(null);
    const active = this.deps.store.get().profileId;
    const target = preferFocus ? (focusId ?? active) : (active ?? focusId);
    const index = this.profiles().findIndex((p) => p.id === target);
    this.pickIndex = index >= 0 ? index : 0;
    this.view = 'picker';
    this.deps.hintsChanged();
    this.buildPicker();
  }

  close(): void {
    this.view = 'closed';
    this.deps.previewTheme(null);
    this.el.hidden = true;
    this.el.replaceChildren();
    this.dom = {};
    this.deps.hintsChanged();
  }

  /** A lista de perfis mudou (aviso do daemon). */
  refresh(): void {
    if (this.view === 'picker') {
      if (this.profiles().length === 0) return this.openEditor(null);
      this.pickIndex = Math.min(this.pickIndex, this.pickerCount() - 1);
      this.buildPicker();
    } else if (this.view === 'editor' && this.draft?.id && !this.profiles().some((p) => p.id === this.draft!.id)) {
      this.openPicker(); // o perfil em edição foi excluído
    }
  }

  // ------------------------------------------------------------ escolha

  private pickerCount(): number {
    const n = this.profiles().length;
    return n < MAX_PROFILES ? n + 1 : n;
  }

  private buildPicker(): void {
    const profiles = this.profiles();
    const cards = profiles.map(
      (p, i) =>
        `<button class="pf-card" data-index="${i}" data-profile="${p.id}">${avatarHtml(p)}` +
        `<span class="pf-name">${escapeHtml(p.name)}</span><span class="pf-time"></span></button>`,
    );
    if (profiles.length < MAX_PROFILES) {
      cards.push(
        `<button class="pf-card pf-new" data-index="${profiles.length}"><div class="pf-avatar">${icons.plus}</div>` +
          `<span class="pf-name">Novo perfil</span></button>`,
      );
    }
    this.el.innerHTML = `
      <div class="pf-picker">
        <h1>Quem vai jogar?</h1>
        <p class="pf-sub">Cada perfil tem os próprios jogos salvos. Wi-Fi e controles valem para todos.</p>
        <div class="pf-cards">${cards.join('')}</div>
      </div>`;
    this.el.hidden = false;
    this.dom = {};
    this.el.querySelectorAll<HTMLElement>('.pf-card').forEach((card) =>
      card.addEventListener('click', () => {
        const index = Number(card.dataset.index);
        if (index !== this.pickIndex) {
          this.pickIndex = index;
          this.deps.sounds.move();
          this.renderPicker();
        }
        this.pick();
      }),
    );
    this.renderTotals();
    this.renderPicker();
  }

  setTotals(totals: Record<string, number>): void {
    this.totals = totals;
    if (this.view === 'picker') this.renderTotals();
  }

  private renderTotals(): void {
    this.el.querySelectorAll<HTMLElement>('.pf-card[data-profile]').forEach((card) => {
      const seconds = this.totals[card.dataset.profile!] ?? 0;
      card.querySelector('.pf-time')!.textContent = seconds > 0 ? `${formatPlaytime(seconds)} de jogo` : 'Ainda não jogou';
    });
  }

  private renderPicker(): void {
    this.el.querySelectorAll<HTMLElement>('.pf-card').forEach((card) => {
      card.classList.toggle('focused', Number(card.dataset.index) === this.pickIndex);
    });
    // O menu já se veste com a cor de quem está em foco.
    this.deps.previewTheme(this.profiles()[this.pickIndex]?.color ?? null);
    this.deps.hintsChanged();
  }

  private pick(): void {
    const profile = this.profiles()[this.pickIndex];
    if (!profile) {
      this.deps.sounds.select();
      return this.openEditor(null);
    }
    this.deps.sounds.launch();
    this.deps.choose(profile);
  }

  // ------------------------------------------------------------ editor

  private openEditor(profile: Profile | null): void {
    const used = this.profiles();
    this.draft = profile
      ? { id: profile.id, name: profile.name, icon: profile.icon, color: profile.color }
      : {
          id: null,
          name: '',
          icon: PROFILE_ICONS.find((i) => !used.some((p) => p.icon === i)) ?? PROFILE_ICONS[0],
          color: PROFILE_COLORS.find((c) => !used.some((p) => p.color === c)) ?? PROFILE_COLORS[0],
        };
    this.rows = profile ? ['name', 'icon', 'color', 'save', 'delete'] : ['name', 'icon', 'color', 'save'];
    this.rowIndex = 0;
    this.confirmDelete = false;
    this.view = 'editor';
    this.buildEditor();
  }

  private buildEditor(): void {
    const d = this.draft!;
    const first = this.profiles().length === 0;
    const iconOptions = PROFILE_ICONS.map(
      (i) => `<button class="pf-opt pf-icon-opt" data-icon="${i}" title="${ICON_NAMES[i]}">${profileIcons[i]}</button>`,
    ).join('');
    const colorOptions = PROFILE_COLORS.map(
      (c) => `<button class="pf-opt pf-color-opt" data-color="${c}" title="${COLOR_NAMES[c]}" style="background:${gradient(c)}"></button>`,
    ).join('');
    this.el.innerHTML = `
      <div class="pf-editor">
        <div class="pf-preview">
          <div class="pf-preview-avatar"></div>
          <span class="pf-preview-name"></span>
        </div>
        <div class="pf-form">
          <h1>${d.id ? 'Editar perfil' : first ? 'Crie seu perfil' : 'Novo perfil'}</h1>
          ${first ? '<p class="pf-sub">Antes de jogar: cada pessoa do console pode ter o seu (até 4).</p>' : ''}
          <div class="pf-row" data-row="name"><span class="pf-label">Nome</span><span class="pf-field pf-name-field"></span></div>
          <div class="pf-row" data-row="icon"><span class="pf-label">Ícone</span><div class="pf-opts">${iconOptions}</div></div>
          <div class="pf-row" data-row="color"><span class="pf-label">Cor</span><div class="pf-opts">${colorOptions}</div></div>
          <div class="pf-actions">
            <button class="pf-btn pf-save" data-row="save">${d.id ? 'Salvar' : 'Criar perfil'}</button>
            ${d.id ? '<button class="pf-btn pf-delete" data-row="delete">Excluir perfil</button>' : ''}
          </div>
          <p class="pf-note"></p>
        </div>
      </div>`;
    this.el.hidden = false;
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.dom = {
      avatar: q('.pf-preview-avatar'),
      previewName: q('.pf-preview-name'),
      nameField: q('.pf-name-field'),
      note: q('.pf-note'),
      deleteBtn: q('.pf-delete'),
    };

    // Mouse
    this.el.querySelectorAll<HTMLElement>('[data-row]').forEach((node) =>
      node.addEventListener('click', (e) => {
        const row = node.dataset.row as EditorRow;
        this.focusRow(row);
        const target = e.target as HTMLElement;
        const icon = target.closest<HTMLElement>('[data-icon]')?.dataset.icon as ProfileIcon | undefined;
        const color = target.closest<HTMLElement>('[data-color]')?.dataset.color as ProfileColor | undefined;
        if (icon) this.setIcon(icon);
        else if (color) this.setColor(color);
        else if (row === 'name' || row === 'save' || row === 'delete') void this.activateRow();
      }),
    );
    this.renderEditor();
  }

  private renderEditor(): void {
    const d = this.draft;
    if (!d || !this.dom.avatar) return;
    const row = this.rows[this.rowIndex];
    this.deps.previewTheme(d.color);
    this.dom.avatar.style.background = gradient(d.color);
    this.dom.avatar.innerHTML = profileIcons[d.icon];
    this.dom.previewName.textContent = d.name || 'Seu nome';
    this.dom.previewName.classList.toggle('placeholder', !d.name);
    this.dom.nameField.textContent = d.name || 'Aperte A para digitar';
    this.dom.nameField.classList.toggle('placeholder', !d.name);
    this.el.querySelectorAll<HTMLElement>('[data-row]').forEach((n) => n.classList.toggle('focused', n.dataset.row === row));
    this.el.querySelectorAll<HTMLElement>('[data-icon]').forEach((n) => n.classList.toggle('selected', n.dataset.icon === d.icon));
    this.el.querySelectorAll<HTMLElement>('[data-color]').forEach((n) => n.classList.toggle('selected', n.dataset.color === d.color));
    if (this.dom.deleteBtn) {
      this.dom.deleteBtn.textContent = this.confirmDelete ? 'Aperte A de novo para excluir' : 'Excluir perfil';
      this.dom.deleteBtn.classList.toggle('confirming', this.confirmDelete);
    }
    this.dom.note.textContent =
      row === 'delete'
        ? 'Excluir apaga também todos os jogos salvos deste perfil. Não tem volta.'
        : row === 'icon' || row === 'color'
          ? 'Use ← e → para escolher.'
          : '';
    this.deps.hintsChanged();
  }

  private focusRow(row: EditorRow): void {
    const index = this.rows.indexOf(row);
    if (index < 0 || index === this.rowIndex) return;
    this.rowIndex = index;
    this.confirmDelete = false;
    this.deps.sounds.move();
    this.renderEditor();
  }

  private setIcon(icon: ProfileIcon): void {
    if (!this.draft || this.draft.icon === icon) return;
    this.draft.icon = icon;
    this.deps.sounds.move();
    this.renderEditor();
  }

  private setColor(color: ProfileColor): void {
    if (!this.draft || this.draft.color === color) return;
    this.draft.color = color;
    this.deps.sounds.move();
    this.renderEditor();
  }

  private cycle(dx: number): void {
    const d = this.draft!;
    const row = this.rows[this.rowIndex];
    if (row === 'icon') this.setIcon(step(PROFILE_ICONS, d.icon, dx));
    else if (row === 'color') this.setColor(step(PROFILE_COLORS, d.color, dx));
    else if (row === 'save' || row === 'delete') {
      // Os dois botões ficam lado a lado.
      const next = row === 'save' && dx > 0 ? 'delete' : row === 'delete' && dx < 0 ? 'save' : row;
      this.focusRow(next);
    }
  }

  private async activateRow(): Promise<void> {
    if (this.busy) return;
    const row = this.rows[this.rowIndex];
    if (row === 'name') return this.typeName();
    if (row === 'save') return this.save();
    if (row === 'delete') return this.remove();
    // Ícone e cor: A leva para o próximo campo.
    this.rowIndex++;
    this.deps.sounds.move();
    this.renderEditor();
  }

  private async typeName(): Promise<void> {
    const d = this.draft!;
    this.deps.sounds.select();
    const name = await this.deps.keyboard.open({
      title: d.id ? 'Nome do perfil' : 'Como você se chama?',
      subtitle: `Até ${PROFILE_NAME_MAX} letras. Aparece na tela inicial.`,
      initial: d.name,
      minLength: 1,
      maxLength: PROFILE_NAME_MAX,
      confirmLabel: 'OK',
    });
    if (name === null || this.draft !== d) return this.renderEditor();
    d.name = name.replace(/\s+/g, ' ').trim();
    // Nome preenchido: o foco já vai para o próximo campo.
    if (d.name && this.rows[this.rowIndex] === 'name') this.rowIndex++;
    this.renderEditor();
  }

  private async save(): Promise<void> {
    const d = this.draft!;
    if (!d.name) {
      this.deps.sounds.error();
      this.deps.toast('Escolha um nome para o perfil');
      this.rowIndex = 0;
      this.renderEditor();
      return;
    }
    this.busy = true;
    try {
      const res = await fetch(d.id ? `/api/profiles/${encodeURIComponent(d.id)}` : '/api/profiles', {
        method: d.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: d.name, icon: d.icon, color: d.color }),
      });
      const body = (await res.json().catch(() => ({}))) as Profile & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `erro ${res.status}`);
      this.mergeProfile(body);
      if (d.id) {
        this.deps.sounds.select();
        this.deps.toast('Perfil salvo');
        this.openPicker(d.id, true);
      } else {
        // Perfil novo: já entra jogando com ele.
        this.deps.sounds.launch();
        this.deps.choose(body);
      }
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast(capitalize((err as Error).message), 'error');
    } finally {
      this.busy = false;
    }
  }

  private async remove(): Promise<void> {
    const d = this.draft!;
    if (!d.id) return;
    if (!this.confirmDelete) {
      this.confirmDelete = true;
      this.deps.sounds.error();
      this.renderEditor();
      return;
    }
    this.busy = true;
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`erro ${res.status}`);
      const profiles = this.profiles().filter((p) => p.id !== d.id);
      const { profileId } = this.deps.store.get();
      this.deps.store.update({ profiles, profileId: profileId === d.id ? null : profileId });
      this.deps.sounds.back();
      this.deps.toast(`Perfil “${d.name}” excluído`);
      this.openPicker();
    } catch {
      this.deps.sounds.error();
      this.deps.toast('Não foi possível excluir o perfil', 'error');
    } finally {
      this.busy = false;
    }
  }

  /** Atualiza a lista local na hora (o aviso do daemon chega logo depois, com o mesmo conteúdo). */
  private mergeProfile(profile: Profile): void {
    const list = this.profiles();
    const index = list.findIndex((p) => p.id === profile.id);
    const profiles = index >= 0 ? list.map((p) => (p.id === profile.id ? profile : p)) : [...list, profile];
    this.deps.store.update({ profiles });
  }

  // ------------------------------------------------------------ input

  handleInput(input: PanelInput): void {
    if (this.busy) return;
    if (this.view === 'picker') {
      for (const [action, dx] of [['left', -1], ['right', 1]] as const) {
        if (!input.repeatPressed(action)) continue;
        const next = Math.max(0, Math.min(this.pickerCount() - 1, this.pickIndex + dx));
        if (next !== this.pickIndex) {
          this.pickIndex = next;
          this.deps.sounds.move();
          this.renderPicker();
        }
      }
      if (input.justPressed('confirm')) this.pick();
      if (input.justPressed('action')) {
        const profile = this.profiles()[this.pickIndex];
        if (profile) {
          this.deps.sounds.select();
          this.openEditor(profile);
        }
      }
      if (input.justPressed('back') && this.canClose()) this.deps.close();
      return;
    }
    if (this.view === 'editor') {
      if (input.justPressed('back')) {
        if (this.profiles().length === 0) return; // o primeiro perfil é obrigatório
        this.deps.sounds.back();
        return this.openPicker(this.draft?.id, true);
      }
      for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
        if (!input.repeatPressed(action)) continue;
        let next = this.rowIndex + dy;
        // "Excluir" fica ao lado de "Salvar": descer de Salvar não vai para ele.
        if (this.rows[this.rowIndex] === 'delete' && dy < 0) next = this.rows.indexOf('color');
        if (this.rows[next] === 'delete' && dy > 0) next = this.rowIndex;
        next = Math.max(0, Math.min(this.rows.length - 1, next));
        if (next !== this.rowIndex) {
          this.rowIndex = next;
          this.confirmDelete = false;
          this.deps.sounds.move();
          this.renderEditor();
        }
      }
      for (const [action, dx] of [['left', -1], ['right', 1]] as const) {
        if (input.repeatPressed(action)) this.cycle(dx);
      }
      if (input.justPressed('confirm')) void this.activateRow();
    }
  }

  hints(hint: (glyph: string, label: string) => string): string {
    if (this.view === 'picker') {
      const onProfile = Boolean(this.profiles()[this.pickIndex]);
      return (
        (onProfile ? hint('X', 'Editar') : '') +
        (this.canClose() ? hint('B', 'Voltar') : '') +
        hint('A', onProfile ? 'Jogar' : 'Criar')
      );
    }
    if (this.view === 'editor') {
      const row = this.rows[this.rowIndex];
      const back = this.profiles().length > 0 ? hint('B', 'Voltar') : '';
      if (row === 'icon' || row === 'color') return hint('←→', 'Escolher') + back + hint('A', 'Próximo');
      if (row === 'name') return back + hint('A', 'Digitar nome');
      if (row === 'delete') return back + hint('A', 'Excluir');
      return back + hint('A', this.draft?.id ? 'Salvar' : 'Criar');
    }
    return '';
  }
}

function step<T>(list: readonly T[], current: T, dx: number): T {
  const index = list.indexOf(current);
  return list[(index + dx + list.length) % list.length];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
