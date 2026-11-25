/**
 * Aviso do console por cima do jogo (ex.: bateria fraca), sem pausar nem tirar o foco do jogo.
 * Usa o mesmo palco de 1280x720 da tela inicial (escalado em main.ts) e o mesmo visual de aviso.
 */
export class GameToast {
  private readonly toast: HTMLDivElement;
  private timer: number | undefined;

  constructor() {
    const layer = document.createElement('div');
    layer.id = 'game-toast';
    layer.innerHTML = '<div class="qm-stage"><div class="toast error" role="status"></div></div>';
    document.body.appendChild(layer);
    this.toast = layer.querySelector('.toast') as HTMLDivElement;
  }

  show(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('visible');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.toast.classList.remove('visible'), 5000);
  }
}
