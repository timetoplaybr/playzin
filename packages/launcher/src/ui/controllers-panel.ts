import { getConnectedGamepads, type Action } from '@playzin/sdk';
import type { BluetoothDevice, BluetoothState } from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import type { Sounds } from './sounds';

export interface PanelInput {
  justPressed(action: Action): boolean;
  repeatPressed(action: Action): boolean;
}

type MainItem = { type: 'add' } | { type: 'device'; device: BluetoothDevice };

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
 *   main → lista de pareados (X duas vezes = esquecer) e o botão Adicionar controle
 *   scan → aparelhos encontrados por perto (A = parear, B = voltar)
 */
export class ControllersPanel {
  private view: 'main' | 'scan' = 'main';
  private index = 0;
  private confirmForget: string | null = null;
  /** Controle recém-pareado que deve ganhar a seleção assim que aparecer na lista. */
  private focusAddress: string | null = null;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.view = 'main';
    this.index = 0;
    this.confirmForget = null;
  }

  /** O painel foi fechado: se estava procurando, para a busca. */
  close(): void {
    if (this.view === 'scan') void this.setScan(false);
    this.view = 'main';
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
    const bt = this.bt();
    if (!bt?.available) return [];
    return [{ type: 'add' }, ...bt.devices.filter((d) => d.paired).map((device) => ({ type: 'device' as const, device }))];
  }

  private found(): BluetoothDevice[] {
    return this.bt()?.devices.filter((d) => !d.paired) ?? [];
  }

  private count(): number {
    return this.view === 'main' ? this.mainItems().length : this.found().length;
  }

  // ---------------------------------------------------------------- input

  handleInput(input: PanelInput): 'close' | void {
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
    if (this.view === 'scan') return (this.found().length ? hint('A', 'Parear') : '') + hint('B', 'Voltar');
    const item = this.mainItems()[this.index];
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
    el.innerHTML = this.view === 'scan' ? this.renderScan() : this.renderMain();
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
    const pads = getConnectedGamepads();
    const now = pads.length
      ? pads
          .map(
            (p, i) =>
              `<li class="pad-row"><span class="player-badge">P${i + 1}</span><span class="pad-name">${escapeHtml(cleanPadName(p.id))}</span>` +
              `<span class="pad-map">${p.mapping === 'standard' ? 'mapeamento padrão' : 'mapeamento genérico'}</span></li>`,
          )
          .join('')
      : `<li class="pad-row muted">Nenhum controle conectado agora. O teclado sempre funciona como jogador 1.</li>`;

    let bluetooth: string;
    if (!bt) {
      bluetooth = `<p class="muted">Conectando ao sistema…</p>`;
    } else if (!bt.available) {
      bluetooth = `<p class="muted">Este computador não tem o Bluetooth do console. No Raspberry Pi, é aqui que você pareia os
        controles. Para testar esta tela no PC, ligue o console com <code>npm run start:simulado</code>.</p>`;
    } else {
      const items = this.mainItems();
      bluetooth = `<ul class="save-list">${items
        .map((item, i) => {
          const selected = i === this.index ? ' selected' : '';
          if (item.type === 'add') {
            return `<li class="bt-add${selected}" data-index="${i}"><span class="bt-add-icon">${icons.plus}</span><span class="save-name">Adicionar controle</span></li>`;
          }
          const d = item.device;
          const confirming = this.confirmForget === d.address;
          const meta = confirming ? 'Aperte X de novo para esquecer' : d.connected ? 'Conectado' : 'Pareado · desligado';
          return (
            `<li class="${selected}${confirming ? ' confirming' : ''}" data-index="${i}">` +
            `<span class="save-name">${kindIcon(d)} ${escapeHtml(d.name)}</span><span class="save-meta">${meta}</span>` +
            `<button class="save-delete" title="Esquecer">${icons.trash}</button></li>`
          );
        })
        .join('')}</ul>`;
    }

    return `
      <h2>${icons.gamepad} Controles</h2>
      <h3 class="section-title">Conectados agora</h3>
      <ul class="pad-list">${now}</ul>
      <h3 class="section-title">Bluetooth${bt?.backend === 'mock' ? ' <span class="badge">simulado</span>' : ''}</h3>
      ${bluetooth}`;
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

function cleanPadName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').trim() || id;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
