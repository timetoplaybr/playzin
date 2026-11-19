import { getConnectedGamepads, PlayerInput, type Action } from '@playzin/sdk';
import type { BluetoothDevice, CartridgeInfo, Profile, SaveSummary } from '@playzin/shared';
import type { Library, LibraryEntry } from '../library';
import type { ConsoleState, ConsoleStore } from '../store';
import { ControllersPanel } from './controllers-panel';
import { VirtualKeyboard } from './keyboard';
import { avatarHtml, ProfileScreen } from './profiles';
import { signalIcon, WifiPanel } from './wifi-panel';
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
const VERSION = '0.3.0';
/** Último perfil escolhido (fica no navegador do console, junto com as outras chaves do launcher). */
const LAST_PROFILE_KEY = 'playzin:launcher:last-profile';

type Tile =
  | { kind: 'cartridge'; key: string; cartridge: CartridgeInfo; entry?: LibraryEntry }
  | { kind: 'recent'; key: string; entry: LibraryEntry }
  | { kind: 'empty'; key: string };

type SystemId = 'controllers' | 'wifi' | 'saves' | 'settings' | 'fullscreen' | 'power';
interface SystemButton {
  id: SystemId;
  label: string;
  icon: string;
}

/** Ícones de sistema. "Tela cheia" só aparece quando a janela ainda não ocupa a tela toda. */
function systemButtons(): SystemButton[] {
  const list: SystemButton[] = [
    { id: 'controllers', label: 'Controles', icon: icons.gamepad },
    { id: 'wifi', label: 'Wi-Fi', icon: icons.wifi },
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

type Panel = 'controllers' | 'wifi' | 'saves' | 'settings' | null;

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
  private row: 'profile' | 'tiles' | 'system' = 'tiles';
  private tileIndex = 0;
  private systemIndex = 0;
  private focusKey: string | null = null;
  private panel: Panel = null;
  private readonly ctrlPanel: ControllersPanel;
  private readonly wifiPanel: WifiPanel;
  private readonly keyboard: VirtualKeyboard;
  private readonly profileScreen: ProfileScreen;
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
    profile: HTMLButtonElement;
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
        <button class="profile" title="Trocar de perfil"><div class="avatar">${icons.user}</div><span class="profile-name"></span></button>
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
      profile: q('.profile'),
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
    this.keyboard = new VirtualKeyboard(root, sounds);
    this.wifiPanel = new WifiPanel({
      store,
      sounds,
      keyboard: this.keyboard,
      toast: (text, kind) => this.showToast(text, kind),
      rerender: () => {
        if (this.panel === 'wifi') this.renderPanel();
        this.renderHints();
      },
      isOpen: () => this.panel === 'wifi',
    });
    this.profileScreen = new ProfileScreen(root, {
      store,
      sounds,
      keyboard: this.keyboard,
      toast: (text, kind) => this.showToast(text, kind),
      choose: (profile) => this.chooseProfile(profile),
      close: () => {
        this.sounds.back();
        this.profileScreen.close();
      },
      hintsChanged: () => {
        this.root.classList.toggle('pf-open', this.profileScreen.isOpen);
        this.renderHints();
      },
    });
    this.el.profile.addEventListener('click', () => {
      if (this.panel) this.closePanel();
      this.row = 'profile';
      this.applyFocus();
      this.openProfiles();
    });
    this.buildSystemRow();
    // A linha de sistema muda quando entra/sai da tela cheia (ícone e texto do botão).
    document.addEventListener('fullscreenchange', () => this.buildSystemRow());
    window.addEventListener('resize', () => this.buildSystemRow());
    // Atalho de teclado: F alterna a tela cheia (no menu).
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF' && !e.repeat && this.active && !this.panel && !this.keyboard.isOpen) void this.toggleFullscreen();
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

  onWifiConnected(ssid: string): void {
    this.wifiPanel.onConnected(ssid);
  }

  onWifiError(message: string, ssid: string | undefined, wrongPassword: boolean): void {
    this.wifiPanel.onError(message, ssid, wrongPassword);
  }

  /** Um controle Bluetooth acabou de ser pareado (aviso do daemon). */
  onBluetoothPaired(device: BluetoothDevice, auto: boolean): void {
    this.ctrlPanel.onPaired(device, auto);
  }

  // ---------------------------------------------------------------- perfis

  /** Lista de perfis do daemon (ao conectar e sempre que muda). */
  onProfiles(profiles: Profile[]): void {
    const state = this.store.get();
    const booting = state.profiles === null;
    let profileId = state.profileId;
    if (profileId && !profiles.some((p) => p.id === profileId)) profileId = null;
    // Ao ligar com um perfil só, ele entra direto. Com mais de um, o console pergunta quem vai jogar.
    if (!profileId && booting && profiles.length === 1) profileId = profiles[0].id;
    this.store.update({ profiles, profileId });
    if (profileId) rememberProfile(profileId);
    this.profileScreen.refresh();
    if (!profileId && !this.profileScreen.isOpen && state.status !== 'playing') this.openProfiles();
  }

  /** Abre "Quem vai jogar?" (ou a criação do primeiro perfil). */
  openProfiles(): void {
    if (this.store.get().profiles === null) return; // ainda não sabemos quais perfis existem
    if (this.panel) this.closePanel();
    this.held = null;
    this.profileScreen.openPicker(lastProfile());
  }

  private chooseProfile(profile: Profile): void {
    const changed = this.store.get().profileId !== profile.id;
    this.store.update({ profileId: profile.id });
    rememberProfile(profile.id);
    this.profileScreen.close();
    this.row = 'tiles';
    this.applyFocus();
    if (changed) this.showToast(`Olá, ${profile.name}!`);
  }

  private renderProfile(): void {
    const profile = this.store.profile();
    const signature = profile ? `${profile.id}:${profile.name}:${profile.icon}:${profile.color}` : '';
    if (this.el.profile.dataset.sig === signature) return;
    this.el.profile.dataset.sig = signature;
    this.el.profile.innerHTML = profile
      ? `${avatarHtml(profile, 'avatar')}<span class="profile-name">${escapeHtml(profile.name)}</span>`
      : `<div class="avatar">${icons.user}</div><span class="profile-name"></span>`;
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
    if (state.profiles !== prev.profiles || state.profileId !== prev.profileId) {
      this.renderProfile();
      // Trocou de perfil com "Dados salvos" aberto: recarrega a lista do novo perfil.
      if (this.panel === 'saves' && state.profileId !== prev.profileId) void this.loadSaves();
      if (this.panel === 'settings') this.renderPanel();
    }
    if (state.bluetooth !== prev.bluetooth && this.panel === 'controllers') this.renderPanel();
    if (state.wifi !== prev.wifi && this.panel === 'wifi') this.renderPanel();

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
    this.el.profile.classList.toggle('focused', this.row === 'profile');
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
    if (dy < 0 && this.row === 'tiles') {
      this.row = 'profile';
      this.sounds.move();
    } else if (dy > 0 && this.row === 'profile') {
      this.row = 'tiles';
      this.sounds.move();
    } else if (dy > 0 && this.row === 'tiles') {
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
    if (this.row === 'profile') {
      this.sounds.select();
      return this.openProfiles();
    }
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
    if (panel === 'wifi') this.wifiPanel.open();
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
    if (this.panel === 'wifi') this.wifiPanel.close();
    this.panel = null;
    this.el.backdrop.hidden = true;
    this.sounds.back();
    this.renderHints();
  }

  private async loadSaves(): Promise<void> {
    const profile = this.store.profile();
    try {
      if (!profile) throw new Error('sem perfil');
      const res = await fetch(`/api/saves?profile=${encodeURIComponent(profile.id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
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
    const profile = this.store.profile();
    if (!save || !profile) return;
    if (this.confirmDelete !== save.id) {
      this.confirmDelete = save.id;
      this.sounds.error();
      this.renderPanel();
      return;
    }
    this.confirmDelete = null;
    try {
      const res = await fetch(`/api/saves/${encodeURIComponent(profile.id)}/${encodeURIComponent(save.id)}`, {
        method: 'DELETE',
      });
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
        body = `<p class="muted">Nenhum jogo tem progresso salvo neste perfil ainda.</p>`;
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
      const owner = this.store.profile();
      this.el.panel.innerHTML = `
        <h2>${icons.save} Dados salvos${owner ? ` de ${escapeHtml(owner.name)}` : ''}</h2>
        ${body}
        <p class="muted">O progresso fica guardado no console, não no cartucho, e é separado por perfil. Apagar não tem volta.</p>`;
      this.el.panel.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
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
    } else if (this.panel === 'wifi') {
      this.wifiPanel.render(this.el.panel);
      this.renderHints();
    } else if (this.panel === 'settings') {
      const { cartridge } = this.store.get();
      this.el.panel.innerHTML = `
        <h2>${icons.settings} Configurações</h2>
        <dl class="info">
          <dt>Versão</dt><dd>Playzin ${VERSION}</dd>
          <dt>Perfil</dt><dd>${escapeHtml(this.store.profile()?.name ?? 'Nenhum')} · ${this.store.get().profiles?.length ?? 0} de 4 no console</dd>
          <dt>Sistema</dt><dd>${this.connected ? 'Conectado' : 'Desconectado'}</dd>
          <dt>Rede</dt><dd>${networkLabel(this.store.get().wifi)}</dd>
          <dt>Cartucho</dt><dd>${cartridge ? `${escapeHtml(cartridge.manifest.name)} v${escapeHtml(cartridge.manifest.version)}` : 'Nenhum'}</dd>
          <dt>Jogos na lista</dt><dd>${this.library.list().length}</dd>
          <dt>Resolução</dt><dd>${window.innerWidth}×${window.innerHeight}</dd>
        </dl>`;
    }
  }

  // ---------------------------------------------------------------- barra de status / rodapé

  private renderStatus(): void {
    const { status } = this.store.get();
    // Ícone da barra superior: sinal do Wi-Fi do console. Sem conexão com o sistema, fica vermelho.
    const wifi = this.store.get().wifi;
    if (!this.connected) {
      this.el.net.innerHTML = icons.wifiOff;
      this.el.net.title = 'Sem conexão com o sistema';
    } else if (wifi?.available) {
      this.el.net.innerHTML = wifi.current ? signalIcon(wifi.current.signal) : icons.wifiOff;
      this.el.net.title = wifi.current ? `Wi-Fi: ${wifi.current.ssid}` : 'Sem Wi-Fi';
    } else {
      this.el.net.innerHTML = ''; // no PC, a internet é do próprio computador
    }
    this.el.net.classList.toggle('off', !this.connected);
    this.el.net.classList.toggle('muted-icon', this.connected && Boolean(wifi?.available) && !wifi?.current);
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
    if (this.profileScreen?.isOpen) {
      html = this.profileScreen.hints(hint);
    } else if (this.panel === 'controllers') {
      html = this.ctrlPanel.hints(hint);
    } else if (this.panel === 'wifi') {
      html = this.wifiPanel.hints(hint);
    } else if (this.panel === 'saves') {
      html = (this.saves?.length ? hint('X', 'Apagar progresso') : '') + hint('B', 'Voltar');
    } else if (this.panel) {
      html = hint('B', 'Voltar');
    } else if (this.row === 'profile') {
      html = hint('A', 'Trocar de perfil');
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
    // Teclado virtual aberto: ele recebe todo o input até fechar.
    if (this.keyboard.isOpen) return this.keyboard.update();
    if (this.profileScreen.isOpen) {
      this.profileScreen.handleInput({
        justPressed: (a) => this.input.justPressed(a),
        repeatPressed: (a) => this.repeatPressed(a),
      });
      return;
    }

    if (this.panel === 'wifi') {
      const result = this.wifiPanel.handleInput({
        justPressed: (a) => this.input.justPressed(a),
        repeatPressed: (a) => this.repeatPressed(a),
      });
      if (result === 'close') this.closePanel();
      return;
    }
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

function networkLabel(wifi: import('@playzin/shared').WifiState | null): string {
  if (!wifi?.available) return 'Internet do computador';
  if (!wifi.current) return 'Sem Wi-Fi';
  return `${escapeHtml(wifi.current.ssid)}${wifi.current.ip ? ` · ${escapeHtml(wifi.current.ip)}` : ''}`;
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


function lastProfile(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE_KEY);
  } catch {
    return null;
  }
}

function rememberProfile(id: string): void {
  try {
    localStorage.setItem(LAST_PROFILE_KEY, id);
  } catch {
    /* sem localStorage: o console só não lembra quem jogou por último */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
