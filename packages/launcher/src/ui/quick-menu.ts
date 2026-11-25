import { type Action, PlayerInput, getConnectedGamepads } from '@playzin/sdk';
import type { CartridgeInfo, Profile } from '@playzin/shared';
import { icons, profileIcons } from './icons';
import type { Sounds } from './sounds';

/** Quantos controles o menu escuta (o botão Guide pode vir de qualquer um). */
const MAX_PADS = 8;
const REPEAT_DELAY_MS = 380;
const REPEAT_RATE_MS = 110;

type ItemId = 'resume' | 'restart' | 'quit';

interface Item {
  id: ItemId;
  label: string;
  icon: string;
  /** Pede um segundo A para confirmar (o progresso não salvo pelo jogo se perde). */
  confirm?: string;
}

const ITEMS: Item[] = [
  { id: 'resume', label: 'Continuar', icon: icons.play },
  { id: 'restart', label: 'Reiniciar jogo', icon: icons.refresh, confirm: 'Aperte A de novo para reiniciar' },
  { id: 'quit', label: 'Sair do jogo', icon: icons.power, confirm: 'Aperte A de novo para sair' },
];

export interface QuickMenuActions {
  resume(): void;
  restart(): void;
  quit(): void;
}

/**
 * Menu rápido por cima do jogo (botão Guide, View + Menu ou Esc segurados).
 * O jogo fica pausado por baixo (jogos com o SDK recebem "pause") e o menu
 * escuta todos os controles e o teclado do launcher até fechar.
 */
export class QuickMenu {
  private readonly root: HTMLDivElement;
  private readonly el: { card: HTMLDivElement; list: HTMLUListElement; hints: HTMLDivElement; clock: HTMLSpanElement; info: HTMLDivElement };
  private inputs: PlayerInput[] = [];
  private index = 0;
  private confirming: ItemId | null = null;
  private held: { action: Action; since: number; last: number } | null = null;
  private clockTimer: number | undefined;
  private game: { cartridge: CartridgeInfo; profile: Profile | null; startedAt: number } | null = null;

  constructor(
    private readonly sounds: Sounds,
    private readonly actions: QuickMenuActions,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'quick-menu';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="qm-stage stage-scaled">
        <aside class="qm-card" role="dialog" aria-label="Menu rápido">
          <header class="qm-top"><span class="qm-brand">${icons.cartridge}Playzin</span><span class="qm-clock"></span></header>
          <div class="qm-info"></div>
          <ul class="qm-list"></ul>
          <div class="qm-hints"></div>
        </aside>
      </div>`;
    document.body.appendChild(this.root);
    const q = <T extends Element>(s: string) => this.root.querySelector(s) as T;
    this.el = { card: q('.qm-card'), list: q('.qm-list'), hints: q('.qm-hints'), clock: q('.qm-clock'), info: q('.qm-info') };
    // Clique fora do cartão volta para o jogo.
    this.root.addEventListener('click', (e) => {
      if (!this.el.card.contains(e.target as Node)) this.close('resume');
    });
    // Esc (a tecla que abre o menu) também volta para o jogo. Só um aperto novo conta:
    // a repetição do Esc que ainda está segurado desde o jogo não fecha o menu.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !e.repeat && this.isOpen) this.close('resume');
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Jogo que começou agora (para mostrar nome, capa, perfil e tempo desta partida). */
  setGame(cartridge: CartridgeInfo | null, profile: Profile | null): void {
    this.game = cartridge ? { cartridge, profile, startedAt: Date.now() } : null;
  }

  open(): void {
    if (this.isOpen) return;
    // Controles novos a cada abertura: um botão já segurado (ou um Enter apertado no
    // menu antes de abrir o jogo) não conta como "acabou de apertar".
    this.inputs = Array.from({ length: MAX_PADS }, (_, player) => new PlayerInput({ player, keyboard: player === 0 }));
    this.index = 0;
    this.confirming = null;
    this.held = null;
    this.root.hidden = false;
    this.renderInfo();
    this.renderList();
    this.renderHints();
    this.updateClock();
    this.clockTimer = window.setInterval(() => this.updateClock(), 5000);
    this.sounds.select();
  }

  /** Fecha sem som (ex.: o cartucho foi puxado e o jogo já fechou). */
  hide(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    window.clearInterval(this.clockTimer);
    this.inputs = [];
  }

  /** Chamado a cada frame pelo GameFrame enquanto o menu está aberto. */
  update(): void {
    if (!this.isOpen) return;
    for (const input of this.inputs) input.update();
    if (this.pressed('back')) return this.close('resume');
    if (this.repeat('up')) this.move(-1);
    if (this.repeat('down')) this.move(1);
    if (this.pressed('confirm')) this.activate(this.index);
  }

  private close(id: ItemId): void {
    this.hide();
    if (id === 'resume') {
      this.sounds.back();
      this.actions.resume();
    } else if (id === 'restart') {
      this.sounds.launch();
      this.actions.restart();
    } else {
      this.actions.quit();
    }
  }

  private activate(i: number): void {
    const item = ITEMS[i];
    if (!item) return;
    if (item.confirm && this.confirming !== item.id) {
      this.index = i;
      this.confirming = item.id;
      this.sounds.select();
      this.renderList();
      return;
    }
    this.close(item.id);
  }

  private move(delta: number): void {
    const next = Math.max(0, Math.min(ITEMS.length - 1, this.index + delta));
    if (next === this.index) return;
    this.index = next;
    this.confirming = null;
    this.sounds.move();
    this.renderList();
  }

  private pressed(action: Action): boolean {
    return this.inputs.some((input) => input.justPressed(action));
  }

  private down(action: Action): boolean {
    return this.inputs.some((input) => input.isDown(action));
  }

  /** Direcional com repetição ao segurar, como no menu principal. */
  private repeat(action: Action): boolean {
    const now = performance.now();
    if (this.pressed(action)) {
      this.held = { action, since: now, last: now };
      return true;
    }
    if (this.held?.action !== action) return false;
    if (!this.down(action)) {
      this.held = null;
      return false;
    }
    if (now - this.held.since > REPEAT_DELAY_MS && now - this.held.last > REPEAT_RATE_MS) {
      this.held.last = now;
      return true;
    }
    return false;
  }

  private renderInfo(): void {
    if (!this.game) {
      this.el.info.innerHTML = '';
      return;
    }
    const { cartridge, profile, startedAt } = this.game;
    const name = escapeHtml(cartridge.manifest.name);
    const art = cartridge.coverUrl
      ? `<img src="${escapeHtml(cartridge.coverUrl)}" alt="">`
      : `<span class="qm-initials">${escapeHtml(initials(cartridge.manifest.name))}</span>`;
    const minutes = Math.floor((Date.now() - startedAt) / 60_000);
    const session = minutes < 1 ? 'Começou agora' : `Jogando há ${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`}`;
    const pads = getConnectedGamepads().length;
    const who = profile
      ? `<span class="qm-who"><span class="qm-avatar">${profileIcons[profile.icon] ?? icons.user}</span>${escapeHtml(profile.name)}</span>`
      : '';
    this.el.info.innerHTML = `
      <div class="qm-game">
        <div class="qm-art">${art}</div>
        <div>
          <div class="qm-name">${name}</div>
          <div class="qm-meta">${session}</div>
        </div>
      </div>
      <div class="qm-status">${who}<span class="qm-pads">${icons.gamepad}${pads === 0 ? 'Sem controle' : pads === 1 ? '1 controle' : `${pads} controles`}</span></div>`;
  }

  private renderList(): void {
    this.el.list.innerHTML = ITEMS.map((item, i) => {
      const confirming = this.confirming === item.id;
      const cls = [i === this.index ? 'selected' : '', confirming ? 'confirming' : '', item.id === 'quit' ? 'danger' : ''].filter(Boolean).join(' ');
      return `<li class="${cls}" data-i="${i}">${item.icon}<span>${confirming ? item.confirm : item.label}</span></li>`;
    }).join('');
    this.el.list.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
      li.addEventListener('click', () => this.activate(Number(li.dataset.i)));
    });
  }

  private renderHints(): void {
    const hint = (glyph: string, label: string) => `<span class="hint"><span class="glyph">${glyph}</span>${label}</span>`;
    this.el.hints.innerHTML = hint('A', 'OK') + hint('B', 'Voltar ao jogo');
  }

  private updateClock(): void {
    this.el.clock.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
