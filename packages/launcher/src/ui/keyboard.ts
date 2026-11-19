import { PlayerInput, type Action } from '@playzin/sdk';
import { icons } from './icons';
import type { Sounds } from './sounds';

export interface KeyboardOptions {
  title: string;
  /** Linha de ajuda (ou aviso, como "Senha incorreta") embaixo do título. */
  subtitle?: string;
  subtitleKind?: 'info' | 'error';
  /** Texto escondido (•••), com opção de mostrar. */
  secret?: boolean;
  initial?: string;
  minLength?: number;
  maxLength?: number;
  confirmLabel?: string;
}

type Layout = 'lower' | 'upper' | 'symbols';
type Special = 'shift' | 'backspace' | 'space' | 'ok' | 'symbols' | 'letters';

interface Key {
  /** Caractere digitado, ou a ação especial. */
  value: string | Special;
  label: string;
  /** Largura relativa (1 = tecla comum). */
  width: number;
  special: boolean;
}

const DIGITS = '1234567890'.split('');

function letterRows(upper: boolean): Key[][] {
  const t = (c: string) => (upper ? c.toUpperCase() : c);
  const chars = (s: string) => s.split('').map((c) => key(t(c)));
  return [
    DIGITS.map((c) => key(c)),
    chars('qwertyuiop'),
    [...chars('asdfghjkl'), key('.')],
    [special('shift', upper ? '⇪' : '⇧', 1.5), ...chars('zxcvbnm'), special('backspace', '⌫', 1.5)],
    [special('symbols', '?123', 2), special('space', 'espaço', 6), special('ok', 'OK', 2)],
  ];
}

function symbolRows(): Key[][] {
  const chars = (s: string) => s.split('').map((c) => key(c));
  return [
    DIGITS.map((c) => key(c)),
    chars('!@#$%^&*()'),
    chars('-_=+[]{};:'),
    [...chars('\'",./?\\|~'), special('backspace', '⌫', 1)],
    [special('letters', 'ABC', 2), special('space', 'espaço', 6), special('ok', 'OK', 2)],
  ];
}

function key(c: string): Key {
  return { value: c, label: c, width: 1, special: false };
}

function special(value: Special, label: string, width: number): Key {
  return { value, label, width, special: true };
}

const REPEAT_DELAY_MS = 380;
const REPEAT_RATE_MS = 90;

/**
 * Teclado na tela, feito para o controle:
 *   direcional = escolher a tecla · A = digitar · B = apagar (vazio: cancelar)
 *   X = maiúsculas · Y = mostrar/ocultar senha · Menu (Start) = confirmar
 * Também aceita teclado físico (digitar, Backspace, Enter, Esc) e mouse.
 */
export class VirtualKeyboard {
  private readonly el: HTMLDivElement;
  /** Só o controle: o teclado físico é lido direto (para digitar letras de verdade). */
  private pad = new PlayerInput({ player: 0, keyboard: false });
  private opts: KeyboardOptions = { title: '' };
  private text = '';
  private reveal = false;
  private layout: Layout = 'lower';
  private row = 1;
  private col = 0;
  private resolve: ((value: string | null) => void) | null = null;
  private held: { action: Action; since: number; last: number } | null = null;
  private dom: {
    text: HTMLElement;
    eye: HTMLElement | null;
    counter: HTMLElement | null;
    keys: HTMLElement;
    hints: HTMLElement;
  } | null = null;
  /** O que já está desenhado, para só mexer no que mudou. */
  private drawn: { layout: Layout | null; text: string | null; reveal: boolean | null; focus: string | null; hints: string } = {
    layout: null,
    text: null,
    reveal: null,
    focus: null,
    hints: '',
  };

  constructor(
    host: HTMLElement,
    private readonly sounds: Sounds,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'vk-backdrop';
    this.el.hidden = true;
    host.append(this.el);
    // Fase de captura: o teclado virtual recebe as teclas antes de qualquer outro atalho do menu.
    window.addEventListener('keydown', (e) => this.onPhysicalKey(e), { capture: true });
  }

  get isOpen(): boolean {
    return this.resolve !== null;
  }

  /** Abre o teclado e devolve o texto digitado (ou null se cancelar). */
  open(opts: KeyboardOptions): Promise<string | null> {
    this.resolve?.(null);
    this.opts = opts;
    this.text = opts.initial ?? '';
    this.reveal = false;
    this.layout = 'lower';
    this.row = 1;
    this.col = 0;
    this.held = null;
    // Leitor novo a cada abertura: o "A" que abriu o teclado não pode digitar uma letra.
    this.pad = new PlayerInput({ player: 0, keyboard: false });
    // Marca como aberto antes de desenhar (o render só desenha com o teclado aberto).
    const result = new Promise<string | null>((resolve) => (this.resolve = resolve));
    this.el.hidden = false;
    this.build();
    return result;
  }

  /** Chame a cada frame enquanto estiver aberto. */
  update(): void {
    if (!this.isOpen) return;
    this.pad.update();
    for (const [action, dr, dc] of [
      ['up', -1, 0],
      ['down', 1, 0],
      ['left', 0, -1],
      ['right', 0, 1],
    ] as const) {
      if (this.repeat(action)) this.move(dr, dc);
    }
    if (this.pad.justPressed('confirm')) this.press(this.rows()[this.row][this.col]);
    if (this.pad.justPressed('back')) this.backspaceOrCancel();
    if (this.pad.justPressed('action')) this.toggleShift();
    if (this.pad.justPressed('special')) this.toggleReveal();
    if (this.pad.justPressed('pause')) this.confirm();
  }

  // ---------------------------------------------------------------- ações

  private rows(): Key[][] {
    return this.layout === 'symbols' ? symbolRows() : letterRows(this.layout === 'upper');
  }

  private press(k: Key | undefined): void {
    if (!k) return;
    switch (k.value) {
      case 'shift':
        return this.toggleShift();
      case 'backspace':
        return this.backspace();
      case 'space':
        return this.type(' ');
      case 'ok':
        return this.confirm();
      case 'symbols':
        this.layout = 'symbols';
        this.sounds.move();
        return this.render();
      case 'letters':
        this.layout = 'lower';
        this.sounds.move();
        return this.render();
      default:
        this.type(k.value);
    }
  }

  private type(chars: string): void {
    const max = this.opts.maxLength ?? 128;
    if (this.text.length + chars.length > max) {
      this.sounds.error();
      return;
    }
    this.text += chars;
    this.sounds.move();
    this.render();
  }

  private backspace(): void {
    if (!this.text) return;
    this.text = this.text.slice(0, -1);
    this.sounds.back();
    this.render();
  }

  private backspaceOrCancel(): void {
    if (this.text) this.backspace();
    else this.finish(null);
  }

  private toggleShift(): void {
    this.layout = this.layout === 'upper' ? 'lower' : this.layout === 'lower' ? 'upper' : 'lower';
    this.sounds.move();
    this.render();
  }

  private toggleReveal(): void {
    if (!this.opts.secret) return;
    this.reveal = !this.reveal;
    this.sounds.move();
    this.render();
  }

  private confirm(): void {
    const min = this.opts.minLength ?? 0;
    if (this.text.length < min) {
      this.sounds.error();
      this.flashCounter();
      return;
    }
    this.sounds.select();
    this.finish(this.text);
  }

  private finish(value: string | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.dom = null;
    if (value === null) this.sounds.back();
    resolve?.(value);
  }

  // ---------------------------------------------------------------- navegação

  private move(dr: number, dc: number): void {
    const rows = this.rows();
    if (dc !== 0) {
      const len = rows[this.row].length;
      this.col = (this.col + dc + len) % len;
    } else {
      // Linha de cima/baixo: a tecla mais próxima na horizontal (as linhas têm larguras diferentes).
      const x = this.centerX(rows[this.row], this.col);
      this.row = (this.row + dr + rows.length) % rows.length;
      const target = rows[this.row];
      let best = 0;
      let bestDist = Infinity;
      target.forEach((_, i) => {
        const d = Math.abs(this.centerX(target, i) - x);
        if (d < bestDist) {
          best = i;
          bestDist = d;
        }
      });
      this.col = best;
    }
    this.sounds.move();
    this.render();
  }

  private centerX(row: Key[], index: number): number {
    const total = row.reduce((sum, k) => sum + k.width, 0);
    let x = 0;
    for (let i = 0; i < index; i++) x += row[i].width;
    return (x + row[index].width / 2) / total;
  }

  private repeat(action: Action): boolean {
    const now = performance.now();
    if (this.pad.justPressed(action)) {
      this.held = { action, since: now, last: now };
      return true;
    }
    if (this.held?.action === action) {
      if (!this.pad.isDown(action)) {
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

  // ---------------------------------------------------------------- teclado físico

  private onPhysicalKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // nada de atalhos do menu (F, X…) enquanto digita
    if (e.key === 'Enter') return this.confirm();
    if (e.key === 'Escape') return this.finish(null);
    if (e.key === 'Backspace') return this.backspace();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.type(e.key);
  }

  // ---------------------------------------------------------------- desenho

  private flashCounter(): void {
    const counter = this.el.querySelector('.vk-counter');
    counter?.classList.remove('flash');
    void (counter as HTMLElement | null)?.offsetWidth;
    counter?.classList.add('flash');
  }

  /**
   * Monta o teclado uma vez (ao abrir). Depois disso, render() só atualiza o que mudou:
   * recriar tudo a cada movimento reiniciava as animações e fazia a tela piscar.
   */
  private build(): void {
    const { title, subtitle, subtitleKind, secret, minLength, maxLength } = this.opts;
    this.el.innerHTML = `
      <div class="vk">
        <h2>${escapeHtml(title)}</h2>
        ${subtitle ? `<p class="vk-sub ${subtitleKind === 'error' ? 'error' : ''}">${escapeHtml(subtitle)}</p>` : ''}
        <div class="vk-field">
          <span class="vk-text"></span><span class="vk-caret"></span>
          ${secret ? `<button class="vk-eye" title="Mostrar/ocultar"></button>` : ''}
        </div>
        ${minLength !== undefined || maxLength !== undefined ? '<span class="vk-counter"></span>' : ''}
        <div class="vk-keys"></div>
        <div class="vk-hints"></div>
      </div>`;
    this.dom = {
      text: this.el.querySelector('.vk-text')!,
      eye: this.el.querySelector('.vk-eye'),
      counter: this.el.querySelector('.vk-counter'),
      keys: this.el.querySelector('.vk-keys')!,
      hints: this.el.querySelector('.vk-hints')!,
    };
    this.dom.eye?.addEventListener('click', () => this.toggleReveal());
    // Um único ouvinte para todas as teclas (as teclas são recriadas ao trocar de layout).
    this.dom.keys.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.vk-key');
      if (!btn) return;
      this.row = Number(btn.dataset.r);
      this.col = Number(btn.dataset.c);
      this.press(this.rows()[this.row][this.col]);
    });
    this.drawn = { layout: null, text: null, reveal: null, focus: null, hints: '' };
    this.render();
  }

  private render(): void {
    if (!this.isOpen || !this.dom) return;
    const rows = this.rows();
    this.row = Math.min(this.row, rows.length - 1);
    this.col = Math.min(this.col, rows[this.row].length - 1);
    const { secret, minLength, maxLength } = this.opts;

    // Teclas: só recria ao trocar de layout (letras ↔ maiúsculas ↔ símbolos).
    if (this.drawn.layout !== this.layout) {
      this.dom.keys.innerHTML = rows
        .map(
          (row, r) =>
            `<div class="vk-row">${row
              .map(
                (k, c) =>
                  `<button class="vk-key${k.special ? ' special' : ''}${
                    k.value === 'shift' && this.layout === 'upper' ? ' active' : ''
                  }${k.value === 'ok' ? ' ok' : ''}" style="flex:${k.width}" data-r="${r}" data-c="${c}">${escapeHtml(
                    k.value === 'ok' ? (this.opts.confirmLabel ?? 'OK') : k.label,
                  )}</button>`,
              )
              .join('')}</div>`,
        )
        .join('');
      this.drawn.layout = this.layout;
      this.drawn.focus = null;
    }

    // Tecla em destaque: só troca a classe.
    const focus = `${this.row}:${this.col}`;
    if (this.drawn.focus !== focus) {
      this.dom.keys.querySelector('.vk-key.focused')?.classList.remove('focused');
      this.dom.keys.querySelector(`.vk-key[data-r="${this.row}"][data-c="${this.col}"]`)?.classList.add('focused');
      this.drawn.focus = focus;
    }

    // Texto digitado e contador: só quando mudam.
    if (this.drawn.text !== this.text || this.drawn.reveal !== this.reveal) {
      this.dom.text.textContent = secret && !this.reveal ? '•'.repeat(this.text.length) : this.text;
      if (this.dom.eye) this.dom.eye.innerHTML = this.reveal ? icons.eyeOff : icons.eye;
      if (this.dom.counter) {
        this.dom.counter.textContent = `${this.text.length}${maxLength ? `/${maxLength}` : ''}${
          minLength ? ` · mínimo ${minLength}` : ''
        }`;
        this.dom.counter.classList.toggle('short', this.text.length < (minLength ?? 0));
      }
      this.drawn.text = this.text;
      this.drawn.reveal = this.reveal;
    }

    const hint = (g: string, l: string) => `<span class="hint"><span class="glyph">${g}</span>${l}</span>`;
    const hints =
      hint('A', 'Digitar') +
      hint('B', this.text ? 'Apagar' : 'Cancelar') +
      hint('X', 'Maiúsculas') +
      (secret ? hint('Y', this.reveal ? 'Ocultar' : 'Mostrar') : '') +
      hint('☰', this.opts.confirmLabel ?? 'OK');
    if (this.drawn.hints !== hints) {
      this.dom.hints.innerHTML = hints;
      this.drawn.hints = hints;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
