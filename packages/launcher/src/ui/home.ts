import { getConnectedGamepads, PlayerInput, type Action } from '@playzin/sdk';
import type { BluetoothDevice, CartridgeInfo, SaveSummary } from '@playzin/shared';
import type { Library, LibraryEntry } from '../library';
import type { ConsoleState, ConsoleStore } from '../store';
import { ControllersPanel } from './controllers-panel';
import { icons } from './icons';
import type { Sounds } from './sounds';

export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

const TILE_SIZE = 256;
const TILE_GAP = 16;
const SHELF_PADDING = 64;
const VISIBLE_TILES = 4; // quantos cabem inteiros antes de rolar
const REPEAT_DELAY_MS = 380;
const REPEAT_RATE_MS = 110;
const VERSION = '0.2.0';

type Tile =
  | { kind: 'cartridge'; key: string; cartridge: CartridgeInfo; entry?: LibraryEntry }
  | { kind: 'recent'; key: string; entry: LibraryEntry }
  | { kind: 'empty'; key: string };

type SystemId = 'controllers' | 'saves' | 'settings' | 'fullscreen' | 'power';
interface SystemButton {
  id: SystemId;
  label: string;
  icon: string;
}

/** Ícones de sistema. "Tela cheia" só aparece quando a janela ainda não ocupa a tela toda. */
function systemButtons(): SystemButton[] {
  const list: SystemButton[] = [
    { id: 'controllers', label: 'Controles', icon: icons.gamepad },
    { id: 'saves', label: 'Dados salvos', icon: icons.save },
    { id: 'settings', label: 'Configurações', icon: icons.settings },
  ];
  if (isFullscreen()) list.push({ id: 'fullscreen', label: 'Sair da tela cheia', icon: icons.shrink });
  else if (canGoFullscreen()) list.push({ id: 'fullscreen', label: 'Tela cheia', icon: icons.expand });
  list.push({ id: 'power', label: 'Desligar', icon: icons.power });
  return list;
}

/** Tela cheia pedida pelo próprio console (Fullscreen API). */
function isFullscreen(): boolean {
  return document.fullscreenElement !== null;
}

/**
 * Dá para pedir tela cheia? Não quando o navegador já ocupa a tela inteira por conta
 * própria: modo quiosque (como no Raspberry Pi), F11 ou o botão verde do Mac.
 */
function canGoFullscreen(): boolean {
  if (!document.fullscreenEnabled) return false;
  const coversScreen = window.innerWidth >= screen.width && window.innerHeight >= screen.height;
  return !coversScreen;
}

type Panel = 'controllers' | 'saves' | 'settings' | null;

export interface HomeActions {
  play(cartridge: CartridgeInfo): void;
}

/**
 * Tela inicial no estilo dos consoles atuais: barra de status no topo,
 * fileira de jogos com o selecionado em destaque, ícones de sistema embaixo
 * e as dicas de botões no rodapé. Navega com controle, teclado ou mouse.
 */
export class HomeUI {
  private readonly input = new PlayerInput({ player: 0 });
  private tiles: Tile[] = [];
  private row: 'tiles' | 'system' = 'tiles';
  private tileIndex = 0;
  private systemIndex = 0;
  private focusKey: string | null = null;
  private panel: Panel = null;
  private readonly ctrlPanel: ControllersPanel;
  private sysButtons: SystemButton[] = [];
  private sysSignature = '';
  /** Painel "Dados salvos": lista carregada do console, item selecionado e confirmação de apagar. */
  private saves: SaveSummary[] | null = null;
  private saveIndex = 0;
  private confirmDelete: string | null = null;
  private active = true;
  private rafId: number | undefined;
  private held: { action: Action; since: number; last: number } | null = null;
  private frame = 0;
  private connected = false;
  private toastTimer: number | undefined;
  private tilesSignature = '';

  // elementos
  private readonly el: {
    tiles: HTMLDivElement;
    system: HTMLElement;
    clock: HTMLSpanElement;
    net: HTMLSpanElement;
    pads: HTMLSpanElement;
    hints: HTMLDivElement;
    connState: HTMLSpanElement;
    toast: HTMLDivElement;
    backdrop: HTMLDivElement;
    panel: HTMLDivElement;
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly store: ConsoleStore,
    private readonly library: Library,
    private readonly sounds: Sounds,
    private readonly actions: HomeActions,
  ) {
    root.innerHTML = `
      <header class="topbar">
        <div class="profile"><div class="avatar">${icons.user}</div></div>
        <div class="status">
          <span class="pads" title="Controles conectados"></span>
          <span class="net" title="Sistema"></span>
          <span class="clock"></span>
        </div>
      </header>
      <section class="shelf"><div class="tiles"></div></section>
      <nav class="system-row"></nav>
      <footer class="bottombar">
        <div class="bottom-left"><span class="conn-state"></span></div>
        <div class="hints"></div>
      </footer>
      <div class="toast" role="status"></div>
      <div class="panel-backdrop" hidden><div class="panel"></div></div>
    `;
    const q = <T extends Element>(s: string) => root.querySelector(s) as T;
    this.el = {
      tiles: q('.tiles'),
      system: q('.system-row'),
      clock: q('.clock'),
      net: q('.net'),
      pads: q('.pads'),
      hints: q('.hints'),
      connState: q('.conn-state'),
      toast: q('.toast'),
      backdrop: q('.panel-backdrop'),
      panel: q('.panel'),
    };

    this.ctrlPanel = new ControllersPanel({
      store,
      sounds,
      toast: (text, kind) => this.showToast(text, kind),
      rerender: () => {
        if (this.panel === 'controllers') this.renderPanel();
        this.renderHints();
      },
    });
    this.buildSystemRow();
    // A linha de sistema muda quando entra/sai da tela cheia (ícone e texto do botão).
    document.addEventListener('fullscreenchange', () => this.buildSystemRow());
    window.addEventListener('resize', () => this.buildSystemRow());
    // Atalho de teclado: F alterna a tela cheia (no menu).
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF' && !e.repeat && this.active && !this.panel) void this.toggleFullscreen();
    });
    this.el.backdrop.addEventListener('click', (e) => {
      if (e.target === this.el.backdrop) this.closePanel();
    });

    store.subscribe((state, prev) => this.onState(state, prev));
    library.onChange(() => this.renderTiles());
    window.addEventListener('gamepadconnected', () => this.updatePads());
    window.addEventListener('gamepaddisconnected', () => this.updatePads());

    this.updateClock();
    window.setInterval(() => this.updateClock(), 5000);
    this.updatePads();
    this.renderTiles();
    this.renderStatus();
    this.loop();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.held = null;
    if (active) {
      this.root.classList.remove('sleeping');
      this.el.tiles.querySelectorAll('.launching').forEach((n) => n.classList.remove('launching'));
      if (this.rafId === undefined) this.loop();
    } else {
      this.root.classList.add('sleeping');
      if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }

  /** Um controle Bluetooth acabou de ser pareado (aviso do daemon). */
  onBluetoothPaired(device: BluetoothDevice, auto: boolean): void {
    this.ctrlPanel.onPaired(device, auto);
  }

  showError(text: string): void {
    this.sounds.error();
    this.showToast(text, 'error');
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.renderStatus();
  }

  // ---------------------------------------------------------------- estado

  private onState(state: ConsoleState, prev: ConsoleState): void {
    const now = state.cartridge?.slotId;
    const before = prev.cartridge?.slotId;
    let justInserted: string | undefined;

    if (now && now !== before) {
      // Cartucho novo: vai para a frente da fila e ganha o foco.
      this.row = 'tiles';
      this.focusKey = `cart:${state.cartridge!.manifest.id}`;
      justInserted = this.focusKey;
      this.sounds.insert();
    } else if (!now && before && state.status !== 'connecting') {
      this.sounds.eject();
    }

    this.renderTiles(justInserted);
    this.renderStatus();
    if (state.bluetooth !== prev.bluetooth && this.panel === 'controllers') this.renderPanel();

    if (state.notice && state.notice !== prev.notice) this.showToast(state.notice.text, state.notice.kind);
  }

  // ---------------------------------------------------------------- fileira de jogos

  private buildTiles(): Tile[] {
    const { cartridge } = this.store.get();
    const tiles: Tile[] = [];
    if (cartridge) {
      const id = cartridge.manifest.id;
      tiles.push({ kind: 'cartridge', key: `cart:${id}`, cartridge, entry: this.library.get(id) });
    } else {
      tiles.push({ kind: 'empty', key: 'empty' });
    }
    for (const entry of this.library.list()) {
      if (entry.id !== cartridge?.manifest.id) tiles.push({ kind: 'recent', key: `recent:${entry.id}`, entry });
    }
    return tiles;
  }

  private renderTiles(justInserted?: string): void {
    this.tiles = this.buildTiles();
    const found = this.focusKey ? this.tiles.findIndex((t) => t.key === this.focusKey) : -1;
    this.tileIndex = found >= 0 ? found : Math.min(this.tileIndex, this.tiles.length - 1);
    this.focusKey = this.tiles[this.tileIndex]?.key ?? null;

    // Só recria os elementos se algo visível mudou (evita cortar animações).
    const signature = this.tiles.map(tileSignature).join('|');
    if (signature === this.tilesSignature && !justInserted) return this.applyFocus();
    this.tilesSignature = signature;

    this.el.tiles.replaceChildren(
      ...this.tiles.map((tile, i) => {
        const node = this.renderTile(tile);
        node.addEventListener('click', () => {
          const wasFocused = this.row === 'tiles' && this.tileIndex === i;
          this.focusTile(i);
          if (wasFocused) this.activate();
        });
        if (tile.key === justInserted) node.classList.add('just-inserted');
        return node;
      }),
    );
    this.applyFocus();
  }

  private renderTile(tile: Tile): HTMLButtonElement {
    const node = document.createElement('button');
    node.className = `tile kind-${tile.kind}`;
    node.dataset.key = tile.key;

    const title = document.createElement('div');
    title.className = 'tile-title';
    const art = document.createElement('div');
    art.className = 'tile-art';

    if (tile.kind === 'empty') {
      title.textContent = 'Nenhum cartucho';
      art.innerHTML = `<div class="empty-slot">${icons.insert}<span>Insira um cartucho</span></div>`;
    } else {
      const name = tile.kind === 'cartridge' ? tile.cartridge.manifest.name : tile.entry.name;
      const id = tile.kind === 'cartridge' ? tile.cartridge.manifest.id : tile.entry.id;
      const coverSrc = tile.kind === 'cartridge' ? (tile.cartridge.coverUrl ?? tile.entry?.cover) : tile.entry.cover;
      title.textContent = name;
      if (coverSrc) {
        const img = document.createElement('img');
        img.src = coverSrc;
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', () => art.replaceChildren(generatedArt(id, name)));
        art.append(img);
      } else {
        art.append(generatedArt(id, name));
      }
      if (tile.kind === 'recent') {
        const badge = document.createElement('div');
        badge.className = 'tile-badge';
        badge.innerHTML = `${icons.cartridge}<span>Insira o cartucho</span>`;
        art.append(badge);
      }
    }

    node.append(title, art);
    return node;
  }

  // ---------------------------------------------------------------- linha de sistema

  private buildSystemRow(): void {
    const buttons = systemButtons();
    const signature = buttons.map((b) => `${b.id}:${b.label}`).join('|');
    if (signature === this.sysSignature) return;
    // Mantém o foco no mesmo botão (pelo id), mesmo que a lista mude.
    const focusedId = this.sysButtons[this.systemIndex]?.id;
    this.sysButtons = buttons;
    this.sysSignature = signature;
    const kept = buttons.findIndex((b) => b.id === focusedId);
    this.systemIndex = kept >= 0 ? kept : clamp(this.systemIndex, 0, buttons.length - 1);

    this.el.system.replaceChildren(
      ...buttons.map((btn, i) => {
        const node = document.createElement('button');
        node.className = 'sys-btn';
        node.dataset.id = btn.id;
        node.innerHTML = `<span class="sys-icon">${btn.icon}</span><span class="sys-label">${btn.label}</span>`;
        node.addEventListener('click', () => {
          const wasFocused = this.row === 'system' && this.systemIndex === i;
          this.row = 'system';
          this.systemIndex = i;
          this.applyFocus();
          if (wasFocused) this.activate();
          else this.sounds.move();
        });
        return node;
      }),
    );
    if (this.tiles.length) this.applyFocus();
  }

  // ---------------------------------------------------------------- foco

  private focusTile(index: number): void {
    const changed = this.row !== 'tiles' || this.tileIndex !== index;
    this.row = 'tiles';
    this.tileIndex = index;
    this.focusKey = this.tiles[index]?.key ?? null;
    if (changed) this.sounds.move();
    this.applyFocus();
  }

  private applyFocus(): void {
    const tileNodes = this.el.tiles.children;
    for (let i = 0; i < tileNodes.length; i++) {
      tileNodes[i].classList.toggle('focused', this.row === 'tiles' && i === this.tileIndex);
    }
    const sysNodes = this.el.system.children;
    for (let i = 0; i < sysNodes.length; i++) {
      sysNodes[i].classList.toggle('focused', this.row === 'system' && i === this.systemIndex);
    }

    // Rola a fileira só quando o foco passa do 4º jogo, como nos consoles.
    const firstVisible = Math.max(0, this.tileIndex - (VISIBLE_TILES - 1));
    const maxOffset = Math.max(0, this.tiles.length * (TILE_SIZE + TILE_GAP) - TILE_GAP - (STAGE_WIDTH - 2 * SHELF_PADDING));
    const offset = Math.min(firstVisible * (TILE_SIZE + TILE_GAP), maxOffset);
    this.el.tiles.style.transform = `translateX(${-offset}px)`;

    this.renderHints();
  }

  private move(dx: number, dy: number): void {
    if (dy > 0 && this.row === 'tiles') {
      this.row = 'system';
      this.sounds.move();
    } else if (dy < 0 && this.row === 'system') {
      this.row = 'tiles';
      this.sounds.move();
    } else if (dx !== 0 && this.row === 'tiles') {
      const next = clamp(this.tileIndex + dx, 0, this.tiles.length - 1);
      if (next !== this.tileIndex) {
        this.tileIndex = next;
        this.focusKey = this.tiles[next].key;
        this.sounds.move();
      }
    } else if (dx !== 0 && this.row === 'system') {
      const next = clamp(this.systemIndex + dx, 0, this.sysButtons.length - 1);
      if (next !== this.systemIndex) {
        this.systemIndex = next;
        this.sounds.move();
      }
    }
    this.applyFocus();
  }

  // ---------------------------------------------------------------- ações

  private activate(): void {
    if (this.row === 'system') return this.activateSystem(this.sysButtons[this.systemIndex].id);

    const tile = this.tiles[this.tileIndex];
    if (!tile) return;
    if (tile.kind === 'cartridge') {
      this.sounds.launch();
      this.focusedTileNode()?.classList.add('launching');
      window.setTimeout(() => this.actions.play(tile.cartridge), 220);
    } else if (tile.kind === 'recent') {
      this.sounds.error();
      this.shakeFocused();
      this.showToast(`Insira o cartucho de “${tile.entry.name}” para jogar`);
    } else {
      this.sounds.error();
      this.shakeFocused();
      this.showToast('Coloque um cartucho no console para começar');
    }
  }

  /** X / L: remove da lista um jogo cujo cartucho não está inserido. */
  private secondaryAction(): void {
    const tile = this.tiles[this.tileIndex];
    if (this.row !== 'tiles' || tile?.kind !== 'recent') return;
    this.sounds.back();
    this.library.forget(tile.entry.id);
    this.showToast(`“${tile.entry.name}” removido da lista`);
  }

  private activateSystem(id: SystemId): void {
    if (id === 'fullscreen') return void this.toggleFullscreen();
    if (id === 'power') {
      this.sounds.error();
      this.showToast('Para desligar, use o botão do console');
      return;
    }
    this.sounds.select();
    this.openPanel(id);
  }

  /**
   * Entra ou sai da tela cheia. O navegador só aceita depois de uma tecla ou clique:
   * apertar A no controle não conta, então nesse caso mostramos como fazer.
   * No Chrome/Edge, a tecla Esc fica "presa" ao console (Keyboard Lock): assim o Esc
   * continua servindo para os jogos e para voltar ao menu, e sair da tela cheia passa a ser
   * segurando Esc por alguns segundos (ou por este mesmo botão).
   */
  private async toggleFullscreen(): Promise<void> {
    const keyboard = (navigator as Navigator & { keyboard?: { lock?(keys: string[]): Promise<void>; unlock?(): void } })
      .keyboard;
    try {
      if (isFullscreen()) {
        keyboard?.unlock?.();
        await document.exitFullscreen();
        this.sounds.back();
        return;
      }
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      this.sounds.select();
      try {
        await keyboard?.lock?.(['Escape']);
        this.showToast('Tela cheia: para sair, segure Esc ou use o botão de novo');
      } catch {
        this.showToast('Tela cheia: para sair, aperte Esc ou use o botão de novo');
      }
    } catch {
      this.sounds.error();
      this.showToast('Para a tela cheia, aperte Enter ou F, ou clique no botão (o navegador não aceita pelo controle)');
    }
  }

  private focusedTileNode(): HTMLElement | undefined {
    return this.el.tiles.children[this.tileIndex] as HTMLElement | undefined;
  }

  private shakeFocused(): void {
    const node = this.focusedTileNode();
    if (!node) return;
    node.classList.remove('shake');
    void node.offsetWidth; // reinicia a animação
    node.classList.add('shake');
  }

  // ---------------------------------------------------------------- painéis

  private openPanel(panel: Exclude<Panel, null>): void {
    this.panel = panel;
    if (panel === 'controllers') this.ctrlPanel.open();
    if (panel === 'saves') {
      this.saves = null;
      this.saveIndex = 0;
      this.confirmDelete = null;
      void this.loadSaves();
    }
    this.renderPanel();
    this.el.backdrop.hidden = false;
    this.renderHints();
  }

  private closePanel(): void {
    if (!this.panel) return;
    if (this.panel === 'controllers') this.ctrlPanel.close();
    this.panel = null;
    this.el.backdrop.hidden = true;
    this.sounds.back();
    this.renderHints();
  }

  private async loadSaves(): Promise<void> {
    try {
      const res = await fetch('/api/saves', { cache: 'no-store' });
      const body = (await res.json()) as { saves: SaveSummary[] };
      this.saves = body.saves;
    } catch {
      this.saves = [];
      this.showToast('Não foi possível ler os dados salvos', 'error');
    }
    this.saveIndex = clamp(this.saveIndex, 0, Math.max(0, this.saves.length - 1));
    if (this.panel === 'saves') this.renderPanel();
  }

  /** X no painel: o primeiro aperto pede confirmação, o segundo apaga. */
  private async deleteSelectedSave(): Promise<void> {
    const save = this.saves?.[this.saveIndex];
    if (!save) return;
    if (this.confirmDelete !== save.id) {
      this.confirmDelete = save.id;
      this.sounds.error();
      this.renderPanel();
      return;
    }
    this.confirmDelete = null;
    try {
      const res = await fetch(`/api/saves/${encodeURIComponent(save.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      this.sounds.back();
      this.showToast(`Progresso de “${save.name}” apagado`);
    } catch {
      this.sounds.error();
      this.showToast('Não foi possível apagar', 'error');
    }
    await this.loadSaves();
  }

  private renderPanel(): void {
    if (this.panel === 'saves') {
      let body: string;
      if (this.saves === null) {
        body = `<p class="muted">Carregando…</p>`;
      } else if (this.saves.length === 0) {
        body = `<p class="muted">Nenhum jogo tem progresso salvo ainda.</p>`;
      } else {
        body = `<ul class="save-list">${this.saves
          .map((s, i) => {
            const confirming = this.confirmDelete === s.id;
            return (
              `<li class="${i === this.saveIndex ? 'selected' : ''}${confirming ? ' confirming' : ''}" data-index="${i}">` +
              `<span class="save-name">${escapeHtml(s.name)}</span>` +
              `<span class="save-meta">${confirming ? 'Aperte X de novo para apagar' : `${formatDate(s.updatedAt)} · ${formatBytes(s.bytes)}`}</span>` +
              `<button class="save-delete" data-index="${i}" title="Apagar progresso">${icons.trash}</button></li>`
            );
          })
          .join('')}</ul>`;
      }
      this.el.panel.innerHTML = `
        <h2>${icons.save} Dados salvos</h2>
        ${body}
        <p class="muted">O progresso fica guardado no console, não no cartucho. Apagar não tem volta.</p>`;
      this.el.panel.querySelectorAll<HTMLElement>('.save-list li').forEach((li) =>
        li.addEventListener('click', (e) => {
          const index = Number(li.dataset.index);
          const onDelete = (e.target as HTMLElement).closest('.save-delete');
          if (index !== this.saveIndex) {
            this.saveIndex = index;
            this.confirmDelete = null;
            this.sounds.move();
          }
          if (onDelete) void this.deleteSelectedSave();
          else this.renderPanel();
        }),
      );
      this.renderHints();
    } else if (this.panel === 'controllers') {
      this.ctrlPanel.render(this.el.panel);
      this.renderHints();
    } else if (this.panel === 'settings') {
      const { cartridge } = this.store.get();
      this.el.panel.innerHTML = `
        <h2>${icons.settings} Configurações</h2>
        <dl class="info">
          <dt>Versão</dt><dd>Playzin ${VERSION}</dd>
          <dt>Sistema</dt><dd>${this.connected ? 'Conectado' : 'Desconectado'}</dd>
          <dt>Cartucho</dt><dd>${cartridge ? `${escapeHtml(cartridge.manifest.name)} v${escapeHtml(cartridge.manifest.version)}` : 'Nenhum'}</dd>
          <dt>Jogos na lista</dt><dd>${this.library.list().length}</dd>
          <dt>Resolução</dt><dd>${window.innerWidth}×${window.innerHeight}</dd>
        </dl>`;
    }
  }

  // ---------------------------------------------------------------- barra de status / rodapé

  private renderStatus(): void {
    const { status } = this.store.get();
    this.el.net.innerHTML = this.connected ? icons.wifi : icons.wifiOff;
    this.el.net.classList.toggle('off', !this.connected);
    const bt = this.store.get().bluetooth;
    this.el.connState.textContent =
      !this.connected || status === 'connecting'
        ? 'Conectando ao sistema…'
        : bt?.autoPair
          ? 'Procurando controles Bluetooth: coloque o controle em modo de pareamento'
          : '';
  }

  private renderHints(): void {
    const hint = (glyph: string, label: string) => `<span class="hint"><span class="glyph">${glyph}</span>${label}</span>`;
    let html = '';
    if (this.panel === 'controllers') {
      html = this.ctrlPanel.hints(hint);
    } else if (this.panel === 'saves') {
      html = (this.saves?.length ? hint('X', 'Apagar progresso') : '') + hint('B', 'Voltar');
    } else if (this.panel) {
      html = hint('B', 'Voltar');
    } else if (this.row === 'system') {
      html = hint('A', 'OK');
    } else {
      const tile = this.tiles[this.tileIndex];
      if (tile?.kind === 'cartridge') html = hint('A', 'Jogar');
      else if (tile?.kind === 'recent') html = hint('X', 'Remover da lista') + hint('A', 'OK');
      else html = hint('A', 'OK');
    }
    this.el.hints.innerHTML = html;
  }

  private updateClock(): void {
    this.el.clock.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  private updatePads(): void {
    const count = getConnectedGamepads().length;
    this.el.pads.innerHTML = count > 0 ? `${icons.gamepad}<b>${count}</b>` : '';
    if (this.panel === 'controllers') this.renderPanel();
  }

  private showToast(text: string, kind: 'info' | 'error' = 'info'): void {
    this.el.toast.textContent = text;
    this.el.toast.classList.toggle('error', kind === 'error');
    this.el.toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('visible'), 3500);
  }

  // ---------------------------------------------------------------- input

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (!this.active) return;
    this.input.update();
    if (++this.frame % 30 === 0) this.updatePads();

    if (this.panel === 'controllers') {
      const result = this.ctrlPanel.handleInput({
        justPressed: (a) => this.input.justPressed(a),
        repeatPressed: (a) => this.repeatPressed(a),
      });
      if (result === 'close') this.closePanel();
      return;
    }
    if (this.panel === 'saves') {
      if (this.input.justPressed('back')) return this.closePanel();
      if (this.input.justPressed('action')) void this.deleteSelectedSave();
      const count = this.saves?.length ?? 0;
      for (const [action, , dy] of DIRECTIONS) {
        if (dy === 0 || !this.repeatPressed(action) || count === 0) continue;
        const next = clamp(this.saveIndex + dy, 0, count - 1);
        if (next !== this.saveIndex) {
          this.saveIndex = next;
          this.confirmDelete = null;
          this.sounds.move();
          this.renderPanel();
        }
      }
      return;
    }
    if (this.panel) {
      if (this.input.justPressed('back') || this.input.justPressed('confirm')) this.closePanel();
      return;
    }

    // Verticais primeiro: "cima + esquerda" no mesmo frame troca de linha e depois anda.
    for (const [action, dx, dy] of DIRECTIONS) {
      if (this.repeatPressed(action)) this.move(dx, dy);
    }
    if (this.input.justPressed('confirm')) this.activate();
    if (this.input.justPressed('action')) this.secondaryAction();
  };

  /** Direcional com repetição ao segurar (como em qualquer menu de console). */
  private repeatPressed(action: Action): boolean {
    const now = performance.now();
    if (this.input.justPressed(action)) {
      this.held = { action, since: now, last: now };
      return true;
    }
    if (this.held?.action === action) {
      if (!this.input.isDown(action)) {
        this.held = null;
        return false;
      }
      if (now - this.held.since > REPEAT_DELAY_MS && now - this.held.last > REPEAT_RATE_MS) {
        this.held.last = now;
        return true;
      }
    }
    return false;
  }
}

const DIRECTIONS: [Action, number, number][] = [
  ['up', 0, -1],
  ['down', 0, 1],
  ['left', -1, 0],
  ['right', 1, 0],
];

function tileSignature(tile: Tile): string {
  if (tile.kind === 'cartridge') return `${tile.key}:${tile.cartridge.slotId}:${tile.cartridge.coverUrl ?? (tile.entry?.cover ? 'c' : '')}`;
  if (tile.kind === 'recent') return `${tile.key}:${tile.entry.name}:${tile.entry.cover?.length ?? 0}`;
  return tile.key;
}

/** Capa gerada para jogos sem cover: cor estável a partir do id + iniciais. */
function generatedArt(id: string, name: string): HTMLElement {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const div = document.createElement('div');
  div.className = 'generated-art';
  div.style.background = `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 50) % 360} 65% 32%))`;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  div.innerHTML = `<span class="initials">${escapeHtml(initials)}</span><span class="art-name">${escapeHtml(name)}</span>`;
  return div;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Hoje, ${time}` : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${time}`;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
