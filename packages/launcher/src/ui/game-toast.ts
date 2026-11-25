import { icons } from './icons';

/**
 * Avisos do console por cima do jogo (bateria fraca, conquista desbloqueada), sem pausar nem
 * tirar o foco do jogo. Usa o mesmo palco de 1280x720 da tela inicial (escalado em main.ts).
 * Um aviso por vez: os que chegam juntos esperam na fila (duas conquistas seguidas, por exemplo).
 */
export class GameToast {
  private readonly toast: HTMLDivElement;
  private readonly queue: { html: string; kind: 'error' | 'achievement' }[] = [];
  private showing = false;

  constructor() {
    const layer = document.createElement('div');
    layer.id = 'game-toast';
    layer.innerHTML = '<div class="qm-stage"><div class="toast" role="status"></div></div>';
    document.body.appendChild(layer);
    this.toast = layer.querySelector('.toast') as HTMLDivElement;
  }

  show(text: string): void {
    this.push(escapeHtml(text), 'error');
  }

  achievement(name: string, unlocked: number, total: number): void {
    this.push(
      `<span class="ach-toast-icon">${icons.trophy}</span>` +
        `<span class="ach-toast-text"><small>Conquista desbloqueada · ${unlocked} de ${total}</small>${escapeHtml(name)}</span>`,
      'achievement',
    );
  }

  private push(html: string, kind: 'error' | 'achievement'): void {
    this.queue.push({ html, kind });
    if (!this.showing) this.next();
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.showing = false;
      return;
    }
    this.showing = true;
    this.toast.innerHTML = item.html;
    this.toast.className = `toast visible ${item.kind}`;
    window.setTimeout(() => {
      this.toast.classList.remove('visible');
      window.setTimeout(() => this.next(), 300); // espera a saída antes do próximo
    }, item.kind === 'achievement' ? 4000 : 5000);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
