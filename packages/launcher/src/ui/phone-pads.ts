import { PHONE_BUTTON_COUNT, type PhonePad } from '@playzin/shared';

/** Os celulares ficam depois dos controles de verdade (que o navegador numera de 0 a 3). */
const FIRST_INDEX = 8;
/** O "modelo" do celular (o remapeamento por modelo trata todos os celulares como um modelo só). */
export const PHONE_PAD_ID = 'Playzin Celular (STANDARD GAMEPAD Vendor: 7a7a Product: 0001)';

interface VirtualButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

/** Um celular, no formato da Gamepad API. */
export interface VirtualPad {
  id: string;
  index: number;
  connected: boolean;
  mapping: 'standard';
  timestamp: number;
  axes: number[];
  buttons: VirtualButton[];
  vibrationActuator: { type: string; playEffect(type: string, params?: { duration?: number }): Promise<string>; reset(): Promise<string> };
  /** De qual celular (PhonePad.id) é este controle. */
  phoneId: string;
  phoneName: string;
}

const pads = new Map<string, VirtualPad>();
let rumbleSink: (phoneId: string, ms: number) => void = () => undefined;

/** Para onde vai a vibração pedida pelos jogos (o launcher manda ao daemon, que manda ao celular). */
export function onPhoneRumble(sink: (phoneId: string, ms: number) => void): void {
  rumbleSink = sink;
}

/** Controles virtuais conectados: entram no navigator.getGamepads() do launcher e dos jogos. */
export function virtualPads(): VirtualPad[] {
  return [...pads.values()].filter((p) => p.connected);
}

/** Nome do celular por trás de um controle (para as listas da TV), se for um celular. */
export function phoneNameForPad(pad: { index: number }): string | null {
  for (const p of pads.values()) if (p.index === pad.index) return p.phoneName;
  return null;
}

/** O Gamepad.index de um celular (para saber qual jogador ele é). */
export function phonePadIndex(phoneId: string): number | null {
  return pads.get(phoneId)?.index ?? null;
}

/**
 * Lista de celulares do daemon: cria os que entraram, tira os que saíram. Um celular que caiu e
 * está voltando (connected: false) some da lista de controles até reconectar, com tudo solto.
 * Devolve quem entrou e quem saiu (para os avisos de conectado/desconectado nas janelas).
 */
export function setPhonePads(list: PhonePad[]): { added: VirtualPad[]; removed: VirtualPad[] } {
  const added: VirtualPad[] = [];
  const removed: VirtualPad[] = [];
  const seen = new Set<string>();
  for (const phone of list) {
    seen.add(phone.id);
    let pad = pads.get(phone.id);
    if (!pad) {
      pad = create(phone);
      pads.set(phone.id, pad);
      if (phone.connected) added.push(pad);
      continue;
    }
    pad.phoneName = phone.name;
    if (pad.connected !== phone.connected) {
      pad.connected = phone.connected;
      if (!phone.connected) release(pad);
      (phone.connected ? added : removed).push(pad);
    }
  }
  for (const [id, pad] of pads) {
    if (seen.has(id)) continue;
    pads.delete(id);
    release(pad);
    pad.connected = false;
    removed.push(pad);
  }
  return { added, removed };
}

/** Botões e analógico que o celular mandou. */
export function phoneInput(id: string, bits: number, x: number, y: number): void {
  const pad = pads.get(id);
  if (!pad) return;
  for (let i = 0; i < PHONE_BUTTON_COUNT; i++) {
    const down = (bits & (1 << i)) !== 0;
    const b = pad.buttons[i]!;
    b.pressed = down;
    b.touched = down;
    b.value = down ? 1 : 0;
  }
  pad.axes[0] = x;
  pad.axes[1] = y;
  pad.timestamp = performance.now();
}

function create(phone: PhonePad): VirtualPad {
  const pad: VirtualPad = {
    id: PHONE_PAD_ID,
    index: FIRST_INDEX + phone.slot,
    connected: phone.connected,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: PHONE_BUTTON_COUNT }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: {
      type: 'dual-rumble',
      playEffect: (_type, params) => {
        rumbleSink(phone.id, params?.duration ?? 150);
        return Promise.resolve('complete');
      },
      reset: () => Promise.resolve('complete'),
    },
    phoneId: phone.id,
    phoneName: phone.name,
  };
  return pad;
}

function release(pad: VirtualPad): void {
  for (const b of pad.buttons) {
    b.pressed = b.touched = false;
    b.value = 0;
  }
  pad.axes[0] = pad.axes[1] = 0;
}
