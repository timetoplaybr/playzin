import { getPlayerGamepads } from '@playzin/sdk';
import { PHONE_MAX, type PhonePad } from '@playzin/shared';
import type { ConsoleStore } from '../store';
import { icons } from './icons';
import { phonePadIndex } from './phone-pads';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

interface Deps {
  store: ConsoleStore;
  sounds: Sounds;
  toast(text: string, kind?: 'info' | 'error'): void;
  rerender(): void;
}

/**
 * "Usar o celular como controle": o QR code (abre a página do controle no celular) e a lista de
 * celulares conectados. Enquanto esta tela está aberta, o QR vale; ao sair, ele deixa de valer
 * (quem já entrou continua conectado).
 *   ↑/↓ = celular · X duas vezes = desconectar · B = voltar
 */
export class PhonePanel {
  private index = 0;
  private confirmKick: string | null = null;

  constructor(private readonly deps: Deps) {}

  open(): void {
    this.index = 0;
    this.confirmKick = null;
    void this.setPairing(true);
  }

  close(): void {
    void this.setPairing(false);
  }

  private pads(): PhonePad[] {
    return this.deps.store.get().phonePads;
  }

  /** 'back' = voltar para a tela Controles. */
  handleInput(input: PanelInput): 'back' | void {
    if (input.justPressed('back')) {
      this.close();
      return 'back';
    }
    const count = this.pads().length;
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action) || count === 0) continue;
      const next = Math.max(0, Math.min(count - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.confirmKick = null;
        this.deps.sounds.move();
        this.deps.rerender();
      }
    }
    if (input.justPressed('action')) void this.kickSelected();
  }

  hints(hint: (glyph: string, label: string) => string): string {
    return (this.pads().length ? hint('X', 'Desconectar') : '') + hint('B', 'Voltar');
  }

  /** X no celular selecionado: o primeiro aperto pede confirmação, o segundo desconecta. */
  private async kickSelected(): Promise<void> {
    const pad = this.pads()[this.index];
    if (!pad) return;
    if (this.confirmKick !== pad.id) {
      this.confirmKick = pad.id;
      this.deps.sounds.error();
      this.deps.rerender();
      return;
    }
    this.confirmKick = null;
    try {
      const res = await fetch(`/api/phone/${encodeURIComponent(pad.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      this.index = Math.max(0, this.index - 1);
    } catch {
      this.deps.sounds.error();
      this.deps.toast('Não foi possível desconectar o celular', 'error');
    }
    this.deps.rerender();
  }

  private async setPairing(on: boolean): Promise<void> {
    try {
      const res = await fetch('/api/phone/pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // O resultado chega pelo WebSocket (phone-pairing).
    } catch {
      if (on) this.deps.toast('Não foi possível gerar o QR code', 'error');
    }
  }

  render(): string {
    const pairing = this.deps.store.get().phonePairing;
    const pads = this.pads();
    this.index = Math.max(0, Math.min(this.index, pads.length - 1));
    const ssid = this.deps.store.get().wifi?.current?.ssid;

    let qr: string;
    if (pairing?.problem) qr = `<div class="phone-qr empty">${icons.wifiOff}</div>`;
    else if (pairing?.qrSvg) qr = `<div class="phone-qr">${pairing.qrSvg}</div>`;
    else qr = `<div class="phone-qr empty"><span class="mini-spinner"></span></div>`;

    const steps = pairing?.problem
      ? `<p class="phone-problem">${escapeHtml(pairing.problem)}</p>`
      : `<ol class="phone-steps">
          <li>Conecte o celular ao <b>mesmo Wi-Fi</b> do console${ssid ? ` (<b>${escapeHtml(ssid)}</b>)` : ''}.</li>
          <li>Aponte a câmera para o código e abra o link.</li>
          <li>Deite o celular e jogue. Até ${PHONE_MAX} celulares.</li>
        </ol>
        ${pairing?.url ? `<p class="muted phone-url">ou digite no navegador: <b>${escapeHtml(pairing.url.replace(/^http:\/\//, ''))}</b></p>` : ''}
        <p class="muted">O código muda toda vez que esta tela abre e para de valer quando ela fecha.</p>`;

    const players = getPlayerGamepads();
    const rows = pads.length
      ? `<ul class="save-list">${pads
          .map((pad, i) => {
            const index = phonePadIndex(pad.id);
            const position = players.findIndex((p) => p?.index === index);
            const confirming = this.confirmKick === pad.id;
            const meta = confirming
              ? 'Aperte X de novo para desconectar'
              : !pad.connected
                ? 'Reconectando… (a tela do celular apagou?)'
                : position >= 0
                  ? `Jogador ${position + 1}`
                  : 'Conectado';
            return (
              `<li class="${i === this.index ? 'selected' : ''}${confirming ? ' confirming' : ''}" data-index="${i}">` +
              `<span class="save-name"><span class="kind-icon">${icons.phone}</span> ${escapeHtml(pad.name)}</span>` +
              `<span class="save-meta">${meta}</span>` +
              `<button class="save-delete" title="Desconectar">${icons.trash}</button></li>`
            );
          })
          .join('')}</ul>`
      : `<p class="muted">Nenhum celular conectado ainda.</p>`;

    return `
      <h2>${icons.phone} Celular como controle</h2>
      <div class="phone-pair">${qr}<div class="phone-info">${steps}</div></div>
      <h3 class="section-title">Celulares conectados</h3>
      ${rows}`;
  }

  /** Clique numa linha (mouse): seleciona; na lixeira, desconecta (duas vezes, como o X). */
  click(i: number, target: EventTarget | null): void {
    if (i !== this.index) {
      this.index = i;
      this.confirmKick = null;
      this.deps.sounds.move();
    }
    if ((target as HTMLElement | null)?.closest?.('.save-delete')) void this.kickSelected();
    else this.deps.rerender();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
