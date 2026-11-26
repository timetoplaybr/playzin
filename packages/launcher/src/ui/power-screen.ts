import type { PowerAction } from '@playzin/shared';
import type { Sounds } from './sounds';

/** No simulado, quanto tempo o "Desligando…" fica na tela antes de "apagar". */
const SIMULATED_MS = 2500;

/**
 * Tela cheia de "Desligando…" / "Reiniciando…", por cima de tudo. Enquanto ela está aberta,
 * o menu não responde a nada.
 *
 * No console de verdade, a tela fica assim até o sistema desligar (a TV fica sem sinal) ou
 * reiniciar (o quiosque abre o launcher do zero). No simulado (PC), depois de alguns segundos
 * a tela "apaga"; qualquer botão "liga" de novo (recarrega o launcher, com a abertura).
 */
export class PowerScreen {
  private readonly el: HTMLDivElement;
  private phase: 'closed' | 'going' | 'off' = 'closed';
  private timer: number | undefined;

  constructor(root: HTMLElement, private readonly sounds: Sounds) {
    this.el = document.createElement('div');
    this.el.className = 'power-screen';
    this.el.hidden = true;
    root.appendChild(this.el);
    this.el.addEventListener('click', () => this.wake());
  }

  get isOpen(): boolean {
    return this.phase !== 'closed';
  }

  /** O daemon avisou que vai desligar/reiniciar. */
  start(action: PowerAction, simulated: boolean): void {
    window.clearTimeout(this.timer);
    this.phase = 'going';
    const reboot = action === 'reboot';
    this.el.classList.remove('off');
    this.el.innerHTML = `
      <div class="spinner"></div>
      <p class="power-title">${reboot ? 'Reiniciando…' : 'Desligando…'}</p>
      <p class="power-sub">${reboot ? 'O console volta sozinho em instantes.' : 'Espere a tela apagar antes de tirar o console da tomada.'}</p>`;
    this.el.hidden = false;
    this.sounds.powerOff();
    if (!simulated) return;
    this.timer = window.setTimeout(() => {
      if (reboot) return location.reload();
      this.phase = 'off';
      this.el.classList.add('off');
      this.el.innerHTML = `<p class="power-sub">Console desligado (simulação).<br>Aperte qualquer botão para ligar.</p>`;
    }, SIMULATED_MS);
  }

  /** Instalando uma atualização: o console reinicia sozinho e a tela volta quando ele subir. */
  updating(version: string): void {
    window.clearTimeout(this.timer);
    this.phase = 'going';
    this.el.classList.remove('off');
    this.el.innerHTML = `
      <div class="spinner"></div>
      <p class="power-title">Atualizando para o Playzin ${version.replace(/[<>&"]/g, '')}…</p>
      <p class="power-sub">O console reinicia sozinho em instantes. Não tire da tomada.</p>`;
    this.el.hidden = false;
  }

  /** O desligamento falhou: volta para o menu. */
  cancel(): void {
    window.clearTimeout(this.timer);
    this.phase = 'closed';
    this.el.hidden = true;
  }

  /** Qualquer botão com a tela "apagada" (só no simulado) liga o console de novo. */
  wake(): void {
    if (this.phase === 'off') location.reload();
  }
}
