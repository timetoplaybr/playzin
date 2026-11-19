import { EventEmitter } from 'node:events';
import type { BluetoothKind } from '@playzin/shared';

/** Um aparelho como o backend o enxerga (antes dos filtros do console). */
export interface RawDevice {
  address: string;
  name: string;
  kind: BluetoothKind;
  paired: boolean;
  connected: boolean;
}

export interface BackendEvents {
  changed: [];
  error: [error: Error];
}

/**
 * Quem fala com o Bluetooth de verdade. Implementações:
 * - BluezBackend: Raspberry Pi / Linux, via D-Bus (org.bluez)
 * - MockBackend: Bluetooth simulado, para testar a tela no PC
 */
export abstract class BluetoothBackend extends EventEmitter<BackendEvents> {
  abstract readonly name: 'bluez' | 'mock';
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract devices(): RawDevice[];
  abstract isScanning(): boolean;
  abstract startScan(): Promise<void>;
  abstract stopScan(): Promise<void>;
  /** Pareia, marca como confiável (reconecta sozinho) e conecta. */
  abstract pair(address: string): Promise<void>;
  /** Esquece o aparelho (desfaz o pareamento). */
  abstract forget(address: string): Promise<void>;
}

/** Erro com mensagem pronta para mostrar na TV. */
export class BluetoothError extends Error {}

const GAMEPAD_NAME = /controller|gamepad|xbox|dualsense|dualshock|wireless controller|8bitdo|joy-?con|pro controller|stadia|joystick/i;

/**
 * Descobre o tipo do aparelho pelo que ele mesmo anuncia: ícone (BlueZ), classe
 * (Bluetooth clássico), aparência (Bluetooth LE) e, por último, o nome.
 */
export function guessKind(info: { icon?: string; cls?: number; appearance?: number; name?: string }): BluetoothKind {
  if (info.icon === 'input-gaming') return 'gamepad';
  if (info.icon === 'input-keyboard') return 'keyboard';
  if (info.icon === 'input-mouse' || info.icon === 'input-tablet') return 'mouse';

  if (info.appearance !== undefined) {
    if (info.appearance === 0x03c3 || info.appearance === 0x03c4) return 'gamepad';
    if (info.appearance === 0x03c1) return 'keyboard';
    if (info.appearance === 0x03c2 || info.appearance === 0x03c5) return 'mouse';
  }

  if (info.cls !== undefined) {
    const major = (info.cls >> 8) & 0x1f;
    if (major === 0x05) {
      // periférico: bits 2–5 = joystick (1) / gamepad (2); bits 6–7 = teclado (1) / mouse (2) / combo (3)
      const sub = (info.cls >> 2) & 0x0f;
      const upper = (info.cls >> 6) & 0x03;
      if (sub === 1 || sub === 2) return 'gamepad';
      if (upper === 1 || upper === 3) return 'keyboard';
      if (upper === 2) return 'mouse';
    }
  }

  if (info.name && GAMEPAD_NAME.test(info.name)) return 'gamepad';
  return 'other';
}
