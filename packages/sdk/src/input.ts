/**
 * Camada de input do Playzin: traduz teclado e controles (Xbox, PlayStation, 8BitDo...)
 * para AÇÕES. O jogo pergunta "o jogador apertou confirm?", não "apertou Enter ou A?".
 *
 * Não depende do Phaser: chame input.update() uma vez por frame (ex.: no update() da cena).
 */

import { isPausedByLauncher } from './launcher-state.js';

export type Action = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'action' | 'special' | 'pause';

export const ACTIONS: readonly Action[] = ['up', 'down', 'left', 'right', 'confirm', 'back', 'action', 'special', 'pause'];

/** Botões no layout "standard" da Gamepad API (o mesmo para Xbox com xpadneo, PS, 8BitDo). */
export const GamepadButton = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8, // "Back/Select"
  MENU: 9, // "Start"
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  GUIDE: 16, // botão Xbox
} as const;

export interface InputBindings {
  keys: Record<Action, string[]>;
  buttons: Record<Action, number[]>;
}

/** Valores de KeyboardEvent.code (independem do layout ABNT/US). */
export const DEFAULT_BINDINGS: InputBindings = {
  keys: {
    up: ['ArrowUp', 'KeyW'],
    down: ['ArrowDown', 'KeyS'],
    left: ['ArrowLeft', 'KeyA'],
    right: ['ArrowRight', 'KeyD'],
    confirm: ['Enter', 'Space', 'KeyJ'],
    back: ['Backspace', 'KeyK'],
    action: ['KeyL', 'ShiftLeft'],
    special: ['KeyI'],
    pause: ['KeyP'],
  },
  buttons: {
    up: [GamepadButton.DPAD_UP],
    down: [GamepadButton.DPAD_DOWN],
    left: [GamepadButton.DPAD_LEFT],
    right: [GamepadButton.DPAD_RIGHT],
    confirm: [GamepadButton.A],
    back: [GamepadButton.B],
    action: [GamepadButton.X],
    special: [GamepadButton.Y],
    pause: [GamepadButton.MENU],
  },
};

export interface PlayerInputOptions {
  /**
   * Qual jogador: 0 = primeiro controle conectado, 1 = segundo...
   * O teclado conta como jogador 0, a não ser que keyboard: false.
   */
  player?: number;
  keyboard?: boolean;
  bindings?: InputBindings;
  /** Zona morta do analógico (0–1). */
  deadZone?: number;
  /** Elemento/janela que recebe o teclado. Padrão: window. */
  target?: Window;
}

interface KeyboardTracker {
  /** Teclas seguradas agora. */
  held: Set<string>;
  /** Quantas vezes cada tecla foi apertada (sem contar auto-repeat). */
  presses: Map<string, number>;
}

const keyboardState = new Map<Window, KeyboardTracker>();

function trackKeyboard(target: Window): KeyboardTracker {
  const existing = keyboardState.get(target);
  if (existing) return existing;
  const tracker: KeyboardTracker = { held: new Set(), presses: new Map() };
  target.addEventListener('keydown', (e) => {
    tracker.held.add(e.code);
    if (!e.repeat) tracker.presses.set(e.code, (tracker.presses.get(e.code) ?? 0) + 1);
  });
  target.addEventListener('keyup', (e) => tracker.held.delete(e.code));
  // Ao perder o foco, solta tudo (evita personagem "andando sozinho").
  target.addEventListener('blur', () => tracker.held.clear());
  keyboardState.set(target, tracker);
  return tracker;
}

export class PlayerInput {
  readonly player: number;
  private readonly useKeyboard: boolean;
  private readonly bindings: InputBindings;
  private readonly deadZone: number;
  private readonly keys: KeyboardTracker;
  private seenPresses = new Map<string, number>();
  private current = new Set<Action>();
  private previous = new Set<Action>();
  private stick = { x: 0, y: 0 };
  private primed = false;

  constructor(options: PlayerInputOptions = {}) {
    this.player = options.player ?? 0;
    this.useKeyboard = options.keyboard ?? this.player === 0;
    this.bindings = options.bindings ?? DEFAULT_BINDINGS;
    this.deadZone = options.deadZone ?? 0.3;
    this.keys = trackKeyboard(options.target ?? window);
  }

  /** Lê teclado e controle. Chame uma vez por frame, antes de consultar as ações. */
  update(): void {
    this.previous = this.current;
    this.current = new Set();
    this.stick = { x: 0, y: 0 };
    this.tapped = new Set();

    // Menu rápido do console aberto: o jogo não vê nada. Ao voltar, o que ainda estiver
    // apertado (ex.: o A de "Continuar") não conta como "acabou de apertar".
    if (isPausedByLauncher()) {
      this.previous = new Set();
      this.primed = false;
      return;
    }

    // Toque rápido (apertou e soltou entre dois frames) ainda conta como "apertou".
    const tapped = new Set<Action>();
    if (this.useKeyboard) {
      for (const action of ACTIONS) {
        for (const code of this.bindings.keys[action]) {
          const presses = this.keys.presses.get(code) ?? 0;
          const seen = this.seenPresses.get(code) ?? 0;
          if (presses !== seen) {
            this.seenPresses.set(code, presses);
            if (this.primed) tapped.add(action);
          }
          if (this.keys.held.has(code)) this.current.add(action);
        }
      }
    }

    const pad = getConnectedGamepads()[this.player];
    if (pad) {
      for (const action of ACTIONS) {
        if (this.bindings.buttons[action].some((i) => pad.buttons[i]?.pressed)) this.current.add(action);
      }
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      this.stick = {
        x: Math.abs(ax) > this.deadZone ? ax : 0,
        y: Math.abs(ay) > this.deadZone ? ay : 0,
      };
      // O analógico também conta como direcional.
      if (this.stick.x < -0.5) this.current.add('left');
      if (this.stick.x > 0.5) this.current.add('right');
      if (this.stick.y < -0.5) this.current.add('up');
      if (this.stick.y > 0.5) this.current.add('down');
    }

    // Botão que já estava apertado quando o jogo abriu (ex.: o "A" usado para
    // iniciar o cartucho) não conta como "acabou de apertar".
    if (!this.primed) {
      this.previous = new Set(this.current);
      this.primed = true;
    }
    this.tapped = tapped;
  }

  private tapped = new Set<Action>();

  /** Está segurando a ação agora. */
  isDown(action: Action): boolean {
    return this.current.has(action);
  }

  /** Apertou neste frame (bom para pular, confirmar menu). */
  justPressed(action: Action): boolean {
    return (this.current.has(action) && !this.previous.has(action)) || this.tapped.has(action);
  }

  justReleased(action: Action): boolean {
    return !this.current.has(action) && this.previous.has(action);
  }

  /**
   * Direção de movimento entre -1 e 1 em cada eixo.
   * Usa o analógico quando ele está fora da zona morta (movimento proporcional);
   * senão, direcional/teclado.
   */
  getMove(): { x: number; y: number } {
    if (this.stick.x !== 0 || this.stick.y !== 0) return { ...this.stick };
    const x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    const y = (this.isDown('down') ? 1 : 0) - (this.isDown('up') ? 1 : 0);
    return { x, y };
  }

  /** Vibração (quando o controle e o driver suportam). */
  rumble(durationMs = 150, strength = 0.6): void {
    const pad = getConnectedGamepads()[this.player] as Gamepad & {
      vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> };
    };
    pad?.vibrationActuator
      ?.playEffect?.('dual-rumble', { duration: durationMs, strongMagnitude: strength, weakMagnitude: strength })
      .catch(() => undefined);
  }

  get hasGamepad(): boolean {
    return getConnectedGamepads()[this.player] !== undefined;
  }
}

/** Controles conectados, na ordem em que foram conectados (sem buracos). */
export function getConnectedGamepads(): Gamepad[] {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  return [...navigator.getGamepads()].filter((p): p is Gamepad => p !== null && p.connected);
}
