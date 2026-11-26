import { assignButton, identityRemap, isIdentityRemap, padModelKey, REMAP_BUTTON_COUNT, REMAP_BUTTON_NAMES } from '@playzin/shared';
import { icons } from './icons';
import { clearModelRemap, getRemap, hasOwnRemap, rawGamepads, remapModels, setRemap, type RemapTarget } from './remap';
import type { Sounds } from './sounds';
import type { PanelInput } from './wifi-panel';

/** O que cada botão faz no console e nos jogos com o SDK. */
const FUNCTIONS = [
  'Confirmar',
  'Voltar',
  'Ação',
  'Especial',
  'Ombro esquerdo',
  'Ombro direito',
  'Gatilho esquerdo',
  'Gatilho direito',
  'View / Select',
  'Menu / Start (pausa)',
  'Apertar o analógico esquerdo',
  'Apertar o analógico direito',
  'Direcional para cima',
  'Direcional para baixo',
  'Direcional para a esquerda',
  'Direcional para a direita',
];

/** A↔B e X↔Y: o jeito dos controles da Nintendo (e de vários 8BitDo). */
const NINTENDO = [1, 0, 3, 2, ...Array.from({ length: REMAP_BUTTON_COUNT - 4 }, (_, i) => i + 4)];
/** Sem apertar nada nesse tempo, a espera pelo botão é cancelada. */
const CAPTURE_TIMEOUT_MS = 8000;

type Item =
  | { type: 'target' }
  | { type: 'button'; logical: number }
  | { type: 'nintendo' }
  | { type: 'reset' }
  | { type: 'follow' };

interface Deps {
  sounds: Sounds;
  toast(text: string, kind?: 'info' | 'error'): void;
  rerender(): void;
}

/**
 * Remapear botões: para todos os controles, ou só para um modelo (o do modelo vale no lugar do
 * de todos). O controle é reconhecido pelo modelo (fabricante + produto): dois iguais dividem.
 *   Linha de cima: ←/→ = de quem é o remapeamento (Todos os controles ou um modelo)
 *   ↑/↓ = escolher · A = trocar (aperta o botão físico que vai fazer aquela função) · B = voltar
 *   Esperando o botão: só vale um controle do modelo escolhido; Esc/Backspace no teclado cancela.
 */
export class RemapPanel {
  private index = 0;
  private target: RemapTarget = 'global';
  private capture: { logical: number; held: Map<number, boolean[]>; until: number } | null = null;
  /**
   * Depois de mudar o remapeamento, o botão ainda apertado muda de papel (o B que acabou de ser
   * escolhido para fazer A "vira" um A apertado). Até soltar tudo, a tela não responde.
   */
  private waitRelease = false;

  constructor(private readonly deps: Deps) {
    // Esperando o botão, qualquer botão do controle é candidato (inclusive o B): o cancelamento é pelo teclado.
    window.addEventListener('keydown', (e) => {
      if (this.capture && (e.code === 'Escape' || e.code === 'Backspace')) {
        this.capture = null;
        this.deps.sounds.back();
        this.deps.rerender();
      }
    });
  }

  open(): void {
    this.index = 0;
    this.capture = null;
    this.waitRelease = false;
    if (!this.targets().includes(this.target)) this.target = 'global';
  }

  // ---------------------------------------------------------------- alvos

  private targets(): RemapTarget[] {
    return ['global', ...remapModels().map((m) => m.key)];
  }

  private targetName(target: RemapTarget = this.target): string {
    if (target === 'global') return 'Todos os controles';
    return remapModels().find((m) => m.key === target)?.name ?? target;
  }

  private changeTarget(delta: number): void {
    const list = this.targets();
    const next = list[(list.indexOf(this.target) + delta + list.length) % list.length]!;
    if (next === this.target || list.length < 2) return;
    this.target = next;
    this.deps.sounds.move();
    this.deps.rerender();
  }

  private items(): Item[] {
    const items: Item[] = [
      { type: 'target' },
      ...Array.from({ length: REMAP_BUTTON_COUNT }, (_, logical) => ({ type: 'button' as const, logical })),
      { type: 'nintendo' },
      { type: 'reset' },
    ];
    if (hasOwnRemap(this.target)) items.push({ type: 'follow' });
    return items;
  }

  /** Mudou o remapeamento: espera soltar os botões antes de aceitar comandos de novo. */
  private changed(): void {
    this.waitRelease = true;
  }

  private apply(next: readonly number[]): void {
    setRemap(this.target, next, this.target === 'global' ? undefined : this.targetName());
    this.changed();
  }

  // ---------------------------------------------------------------- input

  /** 'back' = voltar para a tela Controles. */
  handleInput(input: PanelInput): 'back' | void {
    if (this.capture) return this.pollCapture();
    if (this.waitRelease) {
      if (rawGamepads().some((p) => buttonsOf(p).some(Boolean))) return;
      this.waitRelease = false;
      return; // o quadro em que soltou também não conta
    }
    if (input.justPressed('back')) return 'back';
    const items = this.items();
    if (this.index >= items.length) this.index = items.length - 1;
    for (const [action, dy] of [['up', -1], ['down', 1]] as const) {
      if (!input.repeatPressed(action)) continue;
      const next = Math.max(0, Math.min(items.length - 1, this.index + dy));
      if (next !== this.index) {
        this.index = next;
        this.deps.sounds.move();
        this.deps.rerender();
      }
    }
    if (items[this.index]?.type === 'target') {
      if (input.repeatPressed('left')) this.changeTarget(-1);
      if (input.repeatPressed('right')) this.changeTarget(1);
    }
    if (input.justPressed('confirm')) this.activate();
  }

  private activate(): void {
    const item = this.items()[this.index];
    if (!item) return;
    if (item.type === 'target') return this.changeTarget(1);
    if (item.type === 'button') {
      const pads = this.padsForTarget();
      if (pads.length === 0) {
        this.deps.sounds.error();
        this.deps.toast(this.target === 'global' ? 'Ligue um controle para escolher o botão' : `Ligue um ${this.targetName()} para escolher o botão`, 'error');
        return;
      }
      // O botão usado para escolher (ainda apertado) não conta: só um aperto novo.
      const held = new Map(pads.map((p) => [p.index, buttonsOf(p)]));
      this.capture = { logical: item.logical, held, until: performance.now() + CAPTURE_TIMEOUT_MS };
      this.deps.sounds.select();
      this.deps.rerender();
      return;
    }
    if (item.type === 'nintendo') {
      this.apply(NINTENDO);
      this.deps.sounds.insert();
      this.deps.toast(`Layout Nintendo em ${this.targetName()}: A↔B e X↔Y trocados`);
    } else if (item.type === 'reset') {
      const own = hasOwnRemap(this.target);
      if (isIdentityRemap(getRemap(this.target)) && (this.target === 'global' || own)) {
        this.deps.sounds.error();
        this.deps.toast('Os botões já estão no padrão');
        return;
      }
      this.apply(identityRemap());
      this.deps.sounds.back();
      this.deps.toast(`${this.targetName()}: botões no padrão`);
    } else {
      const name = this.targetName(); // antes de apagar: um modelo desligado some da lista junto
      clearModelRemap(this.target);
      if (!this.targets().includes(this.target)) this.target = 'global';
      this.changed();
      this.index = 0;
      this.deps.sounds.back();
      this.deps.toast(`${name} segue de novo "Todos os controles"`);
    }
    this.deps.rerender();
  }

  /** Controles que valem na espera pelo botão: todos, ou só os do modelo escolhido. */
  private padsForTarget(): Gamepad[] {
    const pads = rawGamepads();
    return this.target === 'global' ? pads : pads.filter((p) => padModelKey(p.id) === this.target);
  }

  private pollCapture(): void {
    const capture = this.capture!;
    if (performance.now() > capture.until) {
      this.capture = null;
      this.deps.sounds.back();
      this.deps.rerender();
      return;
    }
    for (const pad of this.padsForTarget()) {
      const now = buttonsOf(pad);
      const before = capture.held.get(pad.index) ?? [];
      capture.held.set(pad.index, now);
      const physical = now.findIndex((down, i) => down && !before[i]);
      if (physical < 0) continue;
      const logical = capture.logical;
      this.apply(assignButton(getRemap(this.target), logical, physical));
      this.capture = null;
      this.deps.sounds.select();
      const name = REMAP_BUTTON_NAMES[logical];
      this.deps.toast(
        physical === logical ? `${name}: de volta ao botão ${name}` : `${name} agora é o botão ${REMAP_BUTTON_NAMES[physical]}`,
      );
      this.deps.rerender();
      return;
    }
    // Esperando o botão, os outros controles não fazem nada (o sinal do controle certo vem na tela).
    for (const pad of rawGamepads()) capture.held.set(pad.index, buttonsOf(pad));
  }

  hints(hint: (glyph: string, label: string) => string): string {
    if (this.capture) return hint('Esc', 'Cancelar (no teclado)');
    const item = this.items()[this.index];
    if (item?.type === 'target') return hint('↔', 'De qual controle') + hint('B', 'Voltar');
    return hint('A', item?.type === 'button' ? 'Trocar' : 'OK') + hint('B', 'Voltar');
  }

  // ---------------------------------------------------------------- desenho

  render(): string {
    const sources = getRemap(this.target);
    const own = hasOwnRemap(this.target);
    const following = this.target !== 'global' && !own;
    const model = remapModels().find((m) => m.key === this.target);
    const targets = this.targets();
    const rows = this.items()
      .map((item, i) => {
        const selected = i === this.index ? ' selected' : '';
        if (item.type === 'target') {
          const status =
            this.target === 'global'
              ? 'Vale para todo controle sem mapeamento próprio'
              : `${model?.connected ? 'Ligado agora' : 'Desligado'} · ${own ? 'mapeamento próprio' : 'segue "Todos os controles"'}`;
          return (
            `<li class="remap-target${selected}" data-index="${i}">` +
            `<span class="setting-choice">${targets.length > 1 ? `<button class="sc-prev" title="Anterior">${icons.chevronLeft}</button>` : ''}` +
            `<b>${escapeHtml(this.targetName())}</b>` +
            `${targets.length > 1 ? `<button class="sc-next" title="Próximo">${icons.chevronLeft}</button>` : ''}</span>` +
            `<span class="save-meta">${status}</span></li>`
          );
        }
        if (item.type === 'nintendo') {
          return `<li class="remap-action${selected}" data-index="${i}"><span class="save-name">Layout Nintendo</span><span class="save-meta">Troca A↔B e X↔Y</span></li>`;
        }
        if (item.type === 'reset') {
          return `<li class="remap-action${selected}" data-index="${i}"><span class="save-name">Restaurar o padrão</span><span class="save-meta">Cada botão volta a ser ele mesmo${this.target === 'global' ? '' : ' neste modelo'}</span></li>`;
        }
        if (item.type === 'follow') {
          return `<li class="remap-action${selected}" data-index="${i}"><span class="save-name">Seguir "Todos os controles"</span><span class="save-meta">Apaga o mapeamento próprio deste modelo</span></li>`;
        }
        const physical = sources[item.logical]!;
        const waiting = this.capture?.logical === item.logical;
        const changed = physical !== item.logical;
        const source = waiting
          ? `<span class="remap-src waiting">Aperte o botão no ${this.target === 'global' ? 'controle' : escapeHtml(this.targetName())}…</span>`
          : `<span class="remap-src">${changed ? `botão <b class="btn-glyph">${REMAP_BUTTON_NAMES[physical]}</b>` : 'padrão'}</span>`;
        return (
          `<li class="remap-row${selected}${changed ? ' changed' : ''}${waiting ? ' waiting' : ''}${following ? ' inherited' : ''}" data-index="${i}">` +
          `<span class="btn-glyph">${REMAP_BUTTON_NAMES[item.logical]}</span>` +
          `<span class="remap-func">${FUNCTIONS[item.logical]}</span>${source}</li>`
        );
      })
      .join('');
    const help =
      this.target === 'global'
        ? 'Vale para todos os controles e jogos, e para os menus do console. Na linha de cima, escolha um modelo para dar a ele um mapeamento só dele.'
        : following
          ? `Este modelo usa o mapeamento de "Todos os controles" (abaixo). Trocar um botão aqui cria um mapeamento só para ${escapeHtml(this.targetName())}.`
          : `Só para ${escapeHtml(this.targetName())}: dois controles deste modelo usam o mesmo mapeamento.`;
    return `
      <h2>${icons.gamepad} Remapear botões</h2>
      <p class="muted">${help} O teclado (Enter, Backspace) funciona sempre.</p>
      <ul class="save-list remap-list">${rows}</ul>`;
  }

  /** Clique numa linha (mouse): seleciona; clicar de novo troca. Setas da linha de cima: troca o alvo. */
  click(i: number, target?: EventTarget | null): void {
    if (this.capture) return;
    const arrow = (target as HTMLElement | null)?.closest?.('.sc-prev, .sc-next');
    if (arrow) {
      this.index = 0;
      return this.changeTarget(arrow.classList.contains('sc-prev') ? -1 : 1);
    }
    if (i !== this.index) {
      this.index = i;
      this.deps.sounds.move();
      this.deps.rerender();
      return;
    }
    this.activate();
  }
}

function buttonsOf(pad: Gamepad): boolean[] {
  return Array.from({ length: REMAP_BUTTON_COUNT }, (_, i) => Boolean(pad.buttons[i]?.pressed));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
