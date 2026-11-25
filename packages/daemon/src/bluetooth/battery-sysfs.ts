import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bateria dos controles pelo kernel (/sys/class/power_supply), para os que não aparecem no
 * org.bluez.Battery1 do BlueZ: DualSense/DualShock (hid-playstation, hid-sony), Xbox com o
 * xpadneo, Joy-Con/Pro Controller (hid-nintendo).
 *
 * Cada bateria de controle tem scope=Device e aponta (device/) para o aparelho HID, cujo
 * uevent traz HID_UNIQ=<endereço Bluetooth>. É assim que ela é ligada ao controle pareado.
 */

const ROOT = '/sys/class/power_supply';

/** Sem "capacity", alguns drivers só dizem o nível (Low, Normal...). */
const LEVELS: Record<string, number> = { critical: 5, low: 15, normal: 50, high: 80, full: 100 };

export interface HidBattery {
  percent: number | null;
  charging: boolean;
}

/** Baterias de controles, por endereço Bluetooth (maiúsculas). Fora do Linux, vazio. */
export async function readHidBatteries(root = ROOT): Promise<Map<string, HidBattery>> {
  const out = new Map<string, HidBattery>();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if ((await read(dir, 'scope')) !== 'device') continue;
      const uevent = await fs.readFile(path.join(dir, 'device', 'uevent'), 'utf8');
      const uniq = /^HID_UNIQ=(.+)$/m.exec(uevent)?.[1]?.trim().toUpperCase();
      if (!uniq || !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(uniq)) continue;
      const capacity = Number.parseInt(await read(dir, 'capacity').catch(() => ''), 10);
      const level = LEVELS[await read(dir, 'capacity_level').catch(() => '')];
      const status = await read(dir, 'status').catch(() => '');
      out.set(uniq, {
        percent: Number.isFinite(capacity) ? clamp(capacity) : (level ?? null),
        charging: status === 'charging' || status === 'full',
      });
    } catch {
      /* bateria de outro tipo, ou sumiu no meio da leitura */
    }
  }
  return out;
}

async function read(dir: string, file: string): Promise<string> {
  return (await fs.readFile(path.join(dir, file), 'utf8')).trim().toLowerCase();
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
