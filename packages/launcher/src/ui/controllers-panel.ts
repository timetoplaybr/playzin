import { GamepadButton, getConnectedGamepads, getPlayerGamepads, setPlayerOrder, type Action } from '@playzin/sdk';
import type { BluetoothDevice, BluetoothState } from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { batteryLabel, cleanPadName, deviceForPad } from './battery';
import { icons } from './icons';
import { isRemapped } from './remap';
import { RemapPanel } from './remap-panel';
import type { Sounds } from './sounds';

export interface PanelInput {
  justPressed(action: Action): boolean;
  repeatPressed(action: Action): boolean;
}

type MainItem = { type: 'order' } | { type: 'remap' } | { type: 'add' } | { type: 'device'; device: BluetoothDevice };

/** Quantos jogadores a tela de ordem distribui (como nos consoles). */
const MAX_PLAYERS = 4;
/** Depois que todos os controles ligados escolheram, a tela fecha sozinha. */
const ORDER_DONE_DELAY_MS = 900;
const ORDER_BUTTONS = [GamepadButton.A, GamepadButton.B, GamepadButton.MENU] as const;

interface OrderState {
  /** Gamepad.index de cada jogador, na ordem em que apertaram A. */
  slots: number[];
  /** Botões A/B/Menu de cada controle no quadro anterior (para pegar só o aperto novo). */
  prev: Map<number, boolean[]>;
  /** Quando todos escolheram: a hora de fechar sozinha. */
  doneAt: number | null;
  /** Enter do teclado: concluir. */
  keyConfirm: boolean;
}

interface Deps {
  store: ConsoleStore;
  sounds: Sounds;
  toast(text: string, kind?: 'info' | 'error'): void;
  /** Pede para a tela inicial redesenhar o painel e as dicas do rodapé. */
  rerender(): void;
}

/**
 * Painel "Controles": o que está conectado agora e, no console com Bluetooth,
 * os controles pareados + "Adicionar controle" (busca e pareamento).
 *
 *   main  → jogadores agora, "Mudar a ordem dos jogadores", pareados (X duas vezes = esquecer)
 *           e o botão Adicionar controle
 *   scan  → aparelhos encontrados por perto (A = parear, B = voltar)
 *   order → cada jogador aperta A no seu controle, na ordem (Menu ou Enter conclui, B cancela)
 *   remap → remapear botões, para todos os controles e jogos (ui/remap-panel.ts)
 */
export class ControllersPanel {
  private view: 'main' | 'scan' | 'order' | 'remap' = 'main';
  private readonly remap: RemapPanel;
  private order: OrderState | null = null;
  private index = 0;
  private confirmForget: string | null = null;
  /** Controle recém-pareado que deve ganhar a seleção assim que aparecer na lista. */
  private focusAddress: string | null = null;

  constructor(private readonly deps: Deps) {
    this.remap = new RemapPanel({ sounds: deps.sounds, toast: (t, k) => deps.toast(t, k), rerender: () => deps.rerender() });
    window.addEventListener('keydown', (e) => {
      if (this.order && (e.code === 'Enter' || e.code === 'NumpadEnter')) this.order.keyConfirm = true;
    });
  }

  open(): void {
    this.view = 'main';
    this.index = 0;
    this.confirmForget = null;
  }

  /** O painel foi fechado: se estava procurando, para a busca. */
  close(): void {
    if (this.view === 'scan') void this.setScan(false);
    this.view = 'main';
    this.order = null;
  }

  /** Um controle acabou de ser pareado (pela tela ou pelo pareamento automático). */
  onPaired(device: BluetoothDevice, auto: boolean): void {
    this.deps.sounds.insert();
    this.deps.toast(auto ? `Controle conectado automaticamente: ${device.name}` : `Controle conectado: ${device.name}`);
    if (this.view === 'scan') {
      this.view = 'main';
      void this.setScan(false);
      // O aviso de "pareado" pode chegar antes da lista atualizada: a seleção vai para ele no render.
      this.focusAddress = device.address;
    }
    this.deps.rerender();
  }

  // ---------------------------------------------------------------- dados

  private bt(): BluetoothState | null {
    return this.deps.store.get().bluetooth;
  }

  private mainItems(): MainItem[] {
    const items: MainItem[] = [{ type: 'order' }, { type: 'remap' }];
    const bt = this.bt();
    if (!bt?.available) return items;
    return [...items, { type: 'add' }, ...bt.devices.filter((d) => d.paired).map((device) => ({ type: 'device' as const, device }))];
  }

  private found(): BluetoothDevice[] {
    return this.bt()?.devices.filter((d) => !d.paired) ?? [];
  }

  private count(): number {
    return this.view === 'main' ? this.mainItems().length : this.found().length;
  }

  // ---------------------------------------------------------------- input

  handleInput(input: PanelInput): 'close' | void {
    if (this.view === 'remap') {
      if (this.remap.handleInput(input) === 'back') {
        this.view = 'main';
        this.deps.sounds.back();
        this.deps.rerender();
      }
      return;
    }
    if (this.view === 'order') {
      // Backspace (ou o B do Jogador 1) cancela; o resto vem direto de cada controle.
      if (input.justPressed('back')) return this.finishOrder(false);
      return this.pollOrder();
    }
    if (input.justPressed('back')) {
      if (this.view === 'scan') {
        this.view = 'main';
        this.index = 0;
        void this.setScan(false);
        this.deps.sounds.back();
        this.deps.rerender();
        return;
      }
      return 'close';
    }
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action)) continue;
      const next = Math.max(0, Math.min(this.count() - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.confirmForget = null;
        this.deps.sounds.move();
        this.deps.rerender();
      }
    }
    if (input.justPressed('confirm')) this.activate();
    if (input.justPressed('action')) void this.forgetSelected();
  }

  private activate(): void {
    if (this.view === 'main') {
      const item = this.mainItems()[this.index];
      if (item?.type === 'order') return this.startOrder();
      if (item?.type === 'remap') {
        this.view = 'remap';
        this.remap.open();
        this.deps.sounds.select();
        this.deps.rerender();
        return;
      }
      if (item?.type === 'add') {
        this.view = 'scan';
        this.index = 0;
        this.deps.sounds.select();
        void this.setScan(true);
        this.deps.rerender();
      }
      return;
    }
    const device = this.found()[this.index];
    if (device) void this.pair(device);
  }

  // ---------------------------------------------------------------- ordem dos jogadores

  private startOrder(): void {
    const pads = getConnectedGamepads();
    if (pads.length === 0) {
      this.deps.sounds.error();
      this.deps.toast('Ligue um controle primeiro', 'error');
      return;
    }
    // O A usado para abrir esta tela ainda está apertado: só conta o próximo aperto.
    const prev = new Map(pads.map((p) => [p.index, ORDER_BUTTONS.map((b) => Boolean(p.buttons[b]?.pressed))]));
    this.order = { slots: [], prev, doneAt: null, keyConfirm: false };
    this.view = 'order';
    this.deps.sounds.select();
    this.deps.rerender();
  }

  private pollOrder(): void {
    const order = this.order;
    if (!order) return;
    if (order.keyConfirm) return this.finishOrder(true);
    if (order.doneAt !== null) {
      if (performance.now() >= order.doneAt) this.finishOrder(true);
      return;
    }
    const pads = getConnectedGamepads();
    for (const pad of pads) {
      const now = ORDER_BUTTONS.map((b) => Boolean(pad.buttons[b]?.pressed));
      // Controle que apareceu agora (o navegador só mostra depois do primeiro botão): esse aperto vale.
      const before = order.prev.get(pad.index) ?? [false, false, false];
      order.prev.set(pad.index, now);
      const pressed = (i: number) => now[i] && !before[i];
      if (pressed(1)) return this.finishOrder(false);
      if (pressed(2)) return this.finishOrder(true);
      if (pressed(0) && !order.slots.includes(pad.index) && order.slots.length < MAX_PLAYERS) {
        order.slots.push(pad.index);
        this.deps.sounds.select();
        rumble(pad);
        const everyone = pads.every((p) => order.slots.includes(p.index));
        if (everyone || order.slots.length === MAX_PLAYERS) order.doneAt = performance.now() + ORDER_DONE_DELAY_MS;
        this.deps.rerender();
      }
    }
  }

  private finishOrder(save: boolean): void {
    const order = this.order;
    if (!order) return;
    this.order = null;
    this.view = 'main';
    if (save && order.slots.length > 0) {
      setPlayerOrder(order.slots);
      this.deps.sounds.insert();
      const n = order.slots.length;
      this.deps.toast(n === 1 ? 'Pronto: Jogador 1 definido' : `Pronto: ordem de ${n} jogadores definida`);
    } else {
      this.deps.sounds.back();
    }
    this.deps.rerender();
  }

  private async pair(device: BluetoothDevice): Promise<void> {
    if (device.pairing) return;
    this.deps.sounds.select();
    try {
      const res = await fetch(`/api/bluetooth/devices/${encodeURIComponent(device.address)}/pair`, { method: 'POST' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `erro ${res.status}`);
      // O resultado chega pelo WebSocket (bluetooth-paired / bluetooth-error).
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast((err as Error).message, 'error');
    }
  }

  /** X na lista de pareados: o primeiro aperto pede confirmação, o segundo esquece. */
  private async forgetSelected(): Promise<void> {
    if (this.view !== 'main') return;
    const item = this.mainItems()[this.index];
    if (item?.type !== 'device') return;
    const { device } = item;
    if (this.confirmForget !== device.address) {
      this.confirmForget = device.address;
      this.deps.sounds.error();
      this.deps.rerender();
      return;
    }
    this.confirmForget = null;
    try {
      const res = await fetch(`/api/bluetooth/devices/${encodeURIComponent(device.address)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `erro ${res.status}`);
      this.deps.sounds.back();
      this.deps.toast(`“${device.name}” esquecido`);
      this.index = Math.max(0, this.index - 1);
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast((err as Error).message, 'error');
    }
    this.deps.rerender();
  }

  private async setScan(on: boolean): Promise<void> {
    try {
      const res = await fetch('/api/bluetooth/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      if (!res.ok && on) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `erro ${res.status}`);
    } catch (err) {
      if (on) {
        this.deps.sounds.error();
        this.deps.toast((err as Error).message, 'error');
      }
    }
  }

  // ---------------------------------------------------------------- desenho

  hints(hint: (glyph: string, label: string) => string): string {
    if (this.view === 'remap') return this.remap.hints(hint);
    if (this.view === 'order') return hint('A', 'No seu controle: entrar') + hint('☰', 'Concluir') + hint('B', 'Cancelar');
    if (this.view === 'scan') return (this.found().length ? hint('A', 'Parear') : '') + hint('B', 'Voltar');
    const item = this.mainItems()[this.index];
    if (item?.type === 'order') return hint('A', 'Mudar ordem') + hint('B', 'Voltar');
    if (item?.type === 'remap') return hint('A', 'Remapear') + hint('B', 'Voltar');
    if (item?.type === 'add') return hint('A', 'Adicionar') + hint('B', 'Voltar');
    if (item?.type === 'device') return hint('X', 'Esquecer') + hint('B', 'Voltar');
    return hint('B', 'Voltar');
  }

  render(el: HTMLElement): void {
    if (this.focusAddress && this.view === 'main') {
      const i = this.mainItems().findIndex((it) => it.type === 'device' && it.device.address === this.focusAddress);
      if (i >= 0) {
        this.index = i;
        this.focusAddress = null;
      }
    }
    this.index = Math.max(0, Math.min(this.index, Math.max(0, this.count() - 1)));
    if (this.view === 'remap') {
      el.innerHTML = this.remap.render();
      el.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
      el.querySelectorAll<HTMLElement>('[data-index]').forEach((node) =>
        node.addEventListener('click', (e) => this.remap.click(Number(node.dataset.index), e.target)),
      );
      return;
    }
    el.innerHTML = this.view === 'scan' ? this.renderScan() : this.view === 'order' ? this.renderOrder() : this.renderMain();
    // Lista maior que o painel: mantém o item selecionado à vista.
    el.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
    el.querySelectorAll<HTMLElement>('[data-index]').forEach((node) =>
      node.addEventListener('click', (e) => {
        const i = Number(node.dataset.index);
        const forget = (e.target as HTMLElement).closest('.save-delete');
        const wasSelected = i === this.index;
        this.index = i;
        if (forget) {
          // Mesma regra do X: o primeiro clique pede confirmação, o segundo esquece.
          void this.forgetSelected();
          return;
        }
        if (wasSelected) this.activate();
        else {
          this.confirmForget = null;
          this.deps.sounds.move();
          this.deps.rerender();
        }
      }),
    );
  }

  private renderMain(): string {
    const bt = this.bt();
    const players = getPlayerGamepads();
    const now = players.length
      ? players
          .map((p, i) => {
            if (!p) {
              return `<li class="pad-row off"><span class="player-badge">P${i + 1}</span><span class="pad-name muted">Controle desligado</span></li>`;
            }
            const device = deviceForPad(p, bt);
            return (
              `<li class="pad-row"><span class="player-badge">P${i + 1}</span><span class="pad-name">${escapeHtml(cleanPadName(p.id))}</span>` +
              (device?.battery != null
                ? batteryLabel(device)
                : `<span class="pad-map">${p.mapping === 'standard' ? 'mapeamento padrão' : 'mapeamento genérico'}</span>`) +
              `</li>`
            );
          })
          .join('')
      : `<li class="pad-row muted">Nenhum controle conectado agora. O teclado sempre funciona como jogador 1.</li>`;

    const items = this.mainItems();
    const itemHtml = (item: MainItem, i: number): string => {
      const selected = i === this.index ? ' selected' : '';
      if (item.type === 'order') {
        return `<li class="bt-add${selected}" data-index="${i}"><span class="bt-add-icon">${icons.gamepad}</span><span class="save-name">Mudar a ordem dos jogadores</span></li>`;
      }
      if (item.type === 'remap') {
        return (
          `<li class="bt-add remap-entry${selected}" data-index="${i}"><span class="bt-add-icon">${icons.gamepad}</span>` +
          `<span class="save-name">Remapear botões</span><span class="save-meta">${isRemapped() ? 'Botões trocados' : 'Padrão'}</span></li>`
        );
      }
      if (item.type === 'add') {
        return `<li class="bt-add${selected}" data-index="${i}"><span class="bt-add-icon">${icons.plus}</span><span class="save-name">Adicionar controle</span></li>`;
      }
      const d = item.device;
      const confirming = this.confirmForget === d.address;
      const meta = confirming
        ? 'Aperte X de novo para esquecer'
        : d.connected
          ? `Conectado${d.battery !== null ? ` · ${batteryLabel(d)}` : ''}`
          : 'Pareado · desligado';
      return (
        `<li class="${selected}${confirming ? ' confirming' : ''}" data-index="${i}">` +
        `<span class="save-name">${kindIcon(d)} ${escapeHtml(d.name)}</span><span class="save-meta">${meta}</span>` +
        `<button class="save-delete" title="Esquecer">${icons.trash}</button></li>`
      );
    };

    let bluetooth: string;
    if (!bt) {
      bluetooth = `<p class="muted">Conectando ao sistema…</p>`;
    } else if (!bt.available) {
      bluetooth = `<p class="muted">Este computador não tem o Bluetooth do console. No Raspberry Pi, é aqui que você pareia os
        controles. Para testar esta tela no PC, ligue o console com <code>npm run start:simulado</code>.</p>`;
    } else {
      bluetooth = `<ul class="save-list">${items.slice(2).map((item, i) => itemHtml(item, i + 2)).join('')}</ul>`;
    }

    return `
      <h2>${icons.gamepad} Controles</h2>
      <h3 class="section-title">Jogadores</h3>
      <ul class="pad-list">${now}</ul>
      <ul class="save-list order-entry">${itemHtml(items[0]!, 0)}${itemHtml(items[1]!, 1)}</ul>
      <h3 class="section-title">Bluetooth${bt?.backend === 'mock' ? ' <span class="badge">simulado</span>' : ''}</h3>
      ${bluetooth}`;
  }

  private renderOrder(): string {
    const order = this.order;
    const pads = getConnectedGamepads();
    const bt = this.bt();
    const slots = Array.from({ length: MAX_PLAYERS }, (_, i) => {
      const index = order?.slots[i];
      const pad = index === undefined ? undefined : pads.find((p) => p.index === index);
      const next = order !== null && order.doneAt === null && i === order.slots.length;
      const device = pad ? deviceForPad(pad, bt) : undefined;
      const label = pad ? escapeHtml(cleanPadName(pad.id)) : next ? 'Aperte A no seu controle' : '';
      return (
        `<li class="order-slot${pad ? ' filled' : ''}${next ? ' next' : ''}">` +
        `<span class="player-badge">P${i + 1}</span><span class="pad-name">${label}</span>` +
        (device?.battery != null ? batteryLabel(device) : '') +
        `</li>`
      );
    }).join('');
    const done = order?.doneAt !== null;
    return `
      <h2>${icons.gamepad} Ordem dos jogadores</h2>
      <p class="muted">Cada pessoa aperta <b>A</b> no próprio controle, na ordem: primeiro o Jogador 1, depois o 2…
        ${pads.length > 1 ? '' : 'Só há um controle ligado agora.'}</p>
      <ol class="pad-list order-slots">${slots}</ol>
      <p class="muted">${done ? 'Pronto!' : 'Jogos feitos com o SDK do Playzin seguem esta ordem. Ela vale até o console desligar.'}</p>`;
  }

  private renderScan(): string {
    const bt = this.bt();
    const found = this.found();
    const list = found.length
      ? `<ul class="save-list">${found
          .map((d, i) => {
            const selected = i === this.index ? ' selected' : '';
            const meta = d.pairing ? '<span class="busy">Pareando…</span>' : kindLabel(d);
            return `<li class="${selected}${d.pairing ? ' pairing' : ''}" data-index="${i}"><span class="save-name">${kindIcon(d)} ${escapeHtml(d.name)}</span><span class="save-meta">${meta}</span></li>`;
          })
          .join('')}</ul>`
      : `<p class="muted searching"><span class="mini-spinner"></span>Procurando… deixe o controle perto do console.</p>`;
    return `
      <h2>${icons.plus} Adicionar controle${bt?.backend === 'mock' ? ' <span class="badge">simulado</span>' : ''}</h2>
      <p class="muted">Coloque o controle em modo de pareamento:</p>
      <ul class="bt-help">
        <li><b>Xbox</b> segure o botão de parear (ao lado da entrada USB) até a luz piscar rápido</li>
        <li><b>DualSense</b> segure Create + PS · <b>DualShock 4</b> segure Share + PS</li>
        <li><b>8BitDo e outros</b> veja a combinação no manual do controle</li>
      </ul>
      ${found.length ? `<h3 class="section-title">Encontrados ${bt?.scanning ? '<span class="mini-spinner"></span>' : ''}</h3>` : ''}
      ${list}`;
  }
}

function kindIcon(d: BluetoothDevice): string {
  return `<span class="kind-icon">${d.kind === 'keyboard' ? icons.keyboard : d.kind === 'mouse' ? icons.mouse : icons.gamepad}</span>`;
}

function kindLabel(d: BluetoothDevice): string {
  return { gamepad: 'Controle', keyboard: 'Teclado', mouse: 'Mouse', other: 'Aparelho' }[d.kind];
}

/** Vibração curta: "este controle é o Jogador N". */
function rumble(pad: Gamepad): void {
  const actuator = (pad as Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } })
    .vibrationActuator;
  actuator?.playEffect?.('dual-rumble', { duration: 200, strongMagnitude: 0.6, weakMagnitude: 0.6 }).catch(() => undefined);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
