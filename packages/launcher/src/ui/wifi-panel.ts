import type { Action } from '@playzin/sdk';
import type { WifiNetwork, WifiState } from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import type { VirtualKeyboard } from './keyboard';
import type { Sounds } from './sounds';

export interface PanelInput {
  justPressed(action: Action): boolean;
  repeatPressed(action: Action): boolean;
}

interface Deps {
  store: ConsoleStore;
  sounds: Sounds;
  keyboard: VirtualKeyboard;
  toast(text: string, kind?: 'info' | 'error'): void;
  rerender(): void;
  isOpen(): boolean;
}

/** Ícone de sinal com 1 a 3 "ondas" acesas. */
export function signalIcon(signal: number): string {
  const level = signal >= 67 ? 3 : signal >= 34 ? 2 : 1;
  return `<span class="signal lvl-${level}">${icons.wifi1}</span>`;
}

/**
 * Painel "Wi-Fi": a rede atual e as redes por perto.
 *   A = conectar (pede a senha no teclado virtual se for preciso)
 *   X duas vezes = esquecer uma rede salva · Y = procurar de novo · B = voltar
 */
export class WifiPanel {
  private index = 0;
  private confirmForget: string | null = null;
  /** Última rede em que digitamos senha: se ela estiver errada, o teclado abre de novo. */
  private passwordFor: string | null = null;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.index = 0;
    this.confirmForget = null;
    if (this.wifi()?.available) void this.scan();
  }

  close(): void {
    this.confirmForget = null;
  }

  onConnected(ssid: string): void {
    this.deps.sounds.insert();
    this.deps.toast(`Conectado a “${ssid}”`);
    this.index = 0; // a rede conectada vai para o topo da lista
    this.passwordFor = null;
    this.deps.rerender();
  }

  onError(message: string, ssid: string | undefined, wrongPassword: boolean): void {
    this.deps.sounds.error();
    this.deps.toast(message, 'error');
    // Senha errada na rede em que acabamos de digitar: abre o teclado de novo.
    if (wrongPassword && ssid && ssid === this.passwordFor && this.deps.isOpen()) {
      const network = this.networks().find((n) => n.ssid === ssid);
      if (network) void this.askPasswordAndConnect(network, 'Senha incorreta. Tente de novo.');
    }
  }

  // ---------------------------------------------------------------- dados

  private wifi(): WifiState | null {
    return this.deps.store.get().wifi;
  }

  private networks(): WifiNetwork[] {
    return this.wifi()?.networks ?? [];
  }

  // ---------------------------------------------------------------- input

  handleInput(input: PanelInput): 'close' | void {
    if (input.justPressed('back')) return 'close';
    const count = this.networks().length;
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action) || count === 0) continue;
      const next = Math.max(0, Math.min(count - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.confirmForget = null;
        this.deps.sounds.move();
        this.deps.rerender();
      }
    }
    if (input.justPressed('confirm')) void this.activate();
    if (input.justPressed('action')) void this.forgetSelected();
    if (input.justPressed('special')) void this.scan();
  }

  private async activate(): Promise<void> {
    const wifi = this.wifi();
    const network = this.networks()[this.index];
    if (!wifi?.available || !network) return;
    if (network.connected) {
      this.deps.toast(`Já está conectado a “${network.ssid}”`);
      return;
    }
    if (wifi.connecting) {
      this.deps.sounds.error();
      this.deps.toast(`Espere terminar a conexão com “${wifi.connecting}”`);
      return;
    }
    if (network.secured && !network.known) return this.askPasswordAndConnect(network);
    this.deps.sounds.select();
    await this.connect(network.ssid);
  }

  private async askPasswordAndConnect(network: WifiNetwork, subtitle?: string): Promise<void> {
    this.passwordFor = network.ssid;
    const password = await this.deps.keyboard.open({
      title: `Senha de “${network.ssid}”`,
      subtitle: subtitle ?? 'Digite a senha da rede Wi-Fi.',
      subtitleKind: subtitle ? 'error' : 'info',
      secret: true,
      minLength: 8,
      maxLength: 63,
      confirmLabel: 'Conectar',
    });
    if (password === null) {
      this.passwordFor = null;
      this.deps.rerender();
      return;
    }
    await this.connect(network.ssid, password);
  }

  private async connect(ssid: string, password?: string): Promise<void> {
    try {
      const res = await fetch('/api/wifi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(password === undefined ? { ssid } : { ssid, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; wrongPassword?: boolean };
        this.onError(body.error ?? `erro ${res.status}`, ssid, Boolean(body.wrongPassword) && password !== undefined);
      }
      // O resultado chega pelo WebSocket (wifi-connected / wifi-error).
    } catch (err) {
      this.onError((err as Error).message, ssid, false);
    }
    this.deps.rerender();
  }

  private async forgetSelected(): Promise<void> {
    const network = this.networks()[this.index];
    if (!network?.known) return;
    if (this.confirmForget !== network.ssid) {
      this.confirmForget = network.ssid;
      this.deps.sounds.error();
      this.deps.rerender();
      return;
    }
    this.confirmForget = null;
    try {
      const res = await fetch(`/api/wifi/networks/${encodeURIComponent(network.ssid)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `erro ${res.status}`);
      this.deps.sounds.back();
      this.deps.toast(`Rede “${network.ssid}” esquecida`);
    } catch (err) {
      this.deps.sounds.error();
      this.deps.toast((err as Error).message, 'error');
    }
    this.deps.rerender();
  }

  private async scan(): Promise<void> {
    try {
      await fetch('/api/wifi/scan', { method: 'POST' });
    } catch {
      /* sem conexão com o sistema: a tela já avisa */
    }
  }

  // ---------------------------------------------------------------- desenho

  hints(hint: (glyph: string, label: string) => string): string {
    const wifi = this.wifi();
    if (!wifi?.available) return hint('B', 'Voltar');
    const network = this.networks()[this.index];
    return (
      (network && !network.connected ? hint('A', 'Conectar') : '') +
      (network?.known ? hint('X', 'Esquecer') : '') +
      hint('Y', 'Procurar') +
      hint('B', 'Voltar')
    );
  }

  render(el: HTMLElement): void {
    const wifi = this.wifi();
    const networks = this.networks();
    this.index = Math.max(0, Math.min(this.index, Math.max(0, networks.length - 1)));

    if (!wifi) {
      el.innerHTML = `<h2>${icons.wifi} Wi-Fi</h2><p class="muted">Conectando ao sistema…</p>`;
      return;
    }
    if (!wifi.available) {
      el.innerHTML = `
        <h2>${icons.wifi} Wi-Fi</h2>
        <p class="muted">Este computador cuida do próprio Wi-Fi. No Raspberry Pi, é aqui que você escolhe a rede do
        console. Para testar esta tela no PC, ligue o console com <code>npm run start:simulado</code>.</p>`;
      return;
    }

    const status = wifi.current
      ? `<div class="wifi-status ok">${signalIcon(wifi.current.signal)}<div><b>Conectado a “${escapeHtml(wifi.current.ssid)}”</b>
         <span class="muted">${wifi.current.ip ? `IP ${escapeHtml(wifi.current.ip)}` : 'obtendo endereço…'}</span></div></div>`
      : `<div class="wifi-status off">${icons.wifiOff}<div><b>Sem internet</b>
         <span class="muted">Os jogos funcionam, mas o relógio pode ficar errado.</span></div></div>`;

    const list = networks.length
      ? `<ul class="save-list wifi-list">${networks
          .map((n, i) => {
            const selected = i === this.index ? ' selected' : '';
            const confirming = this.confirmForget === n.ssid;
            const busy = wifi.connecting === n.ssid;
            const meta = confirming
              ? 'Aperte X de novo para esquecer'
              : busy
                ? '<span class="busy">Conectando…</span>'
                : n.connected
                  ? 'Conectado'
                  : n.known
                    ? 'Salva'
                    : n.secured
                      ? 'Protegida'
                      : 'Aberta';
            return (
              `<li class="${selected}${confirming ? ' confirming' : ''}${busy ? ' pairing' : ''}${n.connected ? ' connected' : ''}" data-index="${i}">` +
              `<span class="save-name">${signalIcon(n.signal)} ${escapeHtml(n.ssid)} ${n.secured ? `<span class="lock">${icons.lock}</span>` : ''}</span>` +
              `<span class="save-meta">${meta}</span>` +
              (n.known ? `<button class="save-delete" title="Esquecer">${icons.trash}</button>` : '') +
              `</li>`
            );
          })
          .join('')}</ul>`
      : `<p class="muted searching"><span class="mini-spinner"></span>Procurando redes…</p>`;

    el.innerHTML = `
      <h2>${icons.wifi} Wi-Fi${wifi.backend === 'mock' ? ' <span class="badge">simulado</span>' : ''}</h2>
      ${status}
      <h3 class="section-title">Redes por perto ${wifi.scanning ? '<span class="mini-spinner"></span>' : ''}</h3>
      ${list}
      ${wifi.backend === 'mock' ? '<p class="muted">Simulado: a senha das redes protegidas é <code>playzin123</code>.</p>' : ''}`;

    // Lista maior que o painel: mantém o item selecionado à vista.
    el.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
    el.querySelectorAll<HTMLElement>('[data-index]').forEach((node) =>
      node.addEventListener('click', (e) => {
        const i = Number(node.dataset.index);
        const wasSelected = i === this.index;
        this.index = i;
        if ((e.target as HTMLElement).closest('.save-delete')) return void this.forgetSelected();
        if (wasSelected) void this.activate();
        else {
          this.confirmForget = null;
          this.deps.sounds.move();
          this.deps.rerender();
        }
      }),
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
