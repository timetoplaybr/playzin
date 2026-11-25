import { LOW_BATTERY_PERCENT, type BluetoothDevice, type BluetoothState } from '@playzin/shared';

/** Ícone de bateria com o nível preenchido (herda a cor do texto; vermelho quando fraca). */
export function batteryIcon(percent: number, charging = false): string {
  const width = Math.max(1.5, (Math.min(100, percent) / 100) * 15);
  const bolt = charging ? '<path d="M11.5 8.5 9 12.5h3l-1.5 3.5" stroke="var(--bg-deep)" stroke-width="1.6" fill="none"/>' : '';
  return (
    `<svg class="battery-icon" viewBox="0 0 24 24" aria-hidden="true">` +
    `<rect x="2" y="7" width="18" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>` +
    `<rect x="21" y="10" width="1.8" height="4" rx="0.6" fill="currentColor"/>` +
    `<rect x="3.5" y="8.5" width="${width.toFixed(1)}" height="7" rx="1" fill="currentColor"/>${bolt}</svg>`
  );
}

export function isLow(device: Pick<BluetoothDevice, 'battery' | 'charging'>): boolean {
  return device.battery !== null && device.battery <= LOW_BATTERY_PERCENT && !device.charging;
}

/** "🔋 80%" pronto para a TV (vazio quando o aparelho não informa). */
export function batteryLabel(device: Pick<BluetoothDevice, 'battery' | 'charging'>): string {
  if (device.battery === null) return '';
  const cls = isLow(device) ? 'battery low' : device.charging ? 'battery charging' : 'battery';
  return `<span class="${cls}">${batteryIcon(device.battery, device.charging)}${device.battery}%</span>`;
}

/** Controles Bluetooth conectados agora (só esses têm bateria para mostrar). */
export function connectedPads(bt: BluetoothState | null): BluetoothDevice[] {
  return bt?.devices.filter((d) => d.connected && d.kind === 'gamepad') ?? [];
}

/** Nome do controle sem o "(STANDARD GAMEPAD Vendor: ...)" que o navegador acrescenta. */
export function cleanPadName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').trim() || id;
}

/**
 * O aparelho Bluetooth de um controle da Gamepad API. O navegador não diz o endereço, então
 * a ligação é pelo nome, e só quando não há dúvida (um único conectado com aquele nome).
 */
export function deviceForPad(pad: Gamepad, bt: BluetoothState | null): BluetoothDevice | undefined {
  const name = cleanPadName(pad.id).toLowerCase();
  const matches = connectedPads(bt).filter((d) => d.name.toLowerCase() === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Avisa uma vez quando a bateria de um aparelho conectado fica fraca. Avisa de novo só depois
 * que ela subir bem (carregou) ou o aparelho desconectar.
 */
export class LowBatteryWatcher {
  private warned = new Set<string>();

  constructor(private readonly warn: (device: BluetoothDevice) => void) {}

  update(bt: BluetoothState | null): void {
    const connected = new Set<string>();
    for (const d of bt?.devices ?? []) {
      if (!d.connected) continue;
      connected.add(d.address);
      if (isLow(d)) {
        if (!this.warned.has(d.address)) {
          this.warned.add(d.address);
          this.warn(d);
        }
      } else if (d.charging || (d.battery !== null && d.battery > LOW_BATTERY_PERCENT + 10)) {
        this.warned.delete(d.address);
      }
    }
    for (const address of this.warned) if (!connected.has(address)) this.warned.delete(address);
  }
}
