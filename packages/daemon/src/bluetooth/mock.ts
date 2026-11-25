import { BluetoothBackend, BluetoothError, type RawDevice } from './types.js';

interface FakeDevice extends RawDevice {
  /** Falha nas primeiras N tentativas de parear (para testar a mensagem de erro). */
  failures: number;
  /** Bateria depois de conectar (null = o aparelho não informa). */
  level: number | null;
}

/** Aparelhos que "aparecem" durante a busca, com o atraso em ms. */
type Catalog = Omit<FakeDevice, 'paired' | 'connected' | 'battery' | 'charging'>;

const CATALOG: { delay: number; device: Catalog }[] = [
  { delay: 900, device: { address: '7C:ED:8D:11:22:33', name: 'Xbox Wireless Controller', kind: 'gamepad', failures: 0, level: 80 } },
  // Começa com pouca bateria e vai descarregando: serve para ver o aviso de bateria fraca.
  { delay: 1700, device: { address: 'A0:5A:5C:44:55:66', name: 'DualSense Wireless Controller', kind: 'gamepad', failures: 0, level: 16 } },
  { delay: 2500, device: { address: 'E4:17:D8:77:88:99', name: '8BitDo Pro 2', kind: 'gamepad', failures: 1, level: null } },
  { delay: 3000, device: { address: '00:42:79:AA:BB:CC', name: 'JBL Flip 5', kind: 'other', failures: 0, level: 60 } },
  { delay: 3600, device: { address: 'F2:9E:31:DD:EE:FF', name: 'Teclado Logitech K380', kind: 'keyboard', failures: 0, level: 55 } },
];
/** De quanto em quanto tempo a bateria simulada cai 1%. */
const DRAIN_MS = 20_000;

/**
 * Bluetooth simulado: permite usar e testar a tela de pareamento no Mac/Windows,
 * que não têm BlueZ. Nada aqui toca o Bluetooth real do computador.
 * O 8BitDo falha na primeira tentativa, de propósito, para mostrar a mensagem de erro.
 * Bateria: o Xbox tem 80%, o DualSense começa em 16% e descarrega (aviso de bateria fraca),
 * o 8BitDo não informa.
 */
export class MockBackend extends BluetoothBackend {
  readonly name = 'mock' as const;
  private list = new Map<string, FakeDevice>();
  private scanning = false;
  private timers: NodeJS.Timeout[] = [];
  private drain: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    this.drain = setInterval(() => {
      let changed = false;
      for (const d of this.list.values()) {
        if (d.connected && d.level !== null && d.level > 1) {
          d.level -= 1;
          changed = true;
        }
      }
      if (changed) this.emit('changed');
    }, DRAIN_MS);
  }

  async stop(): Promise<void> {
    this.clearTimers();
    clearInterval(this.drain);
  }

  devices(): RawDevice[] {
    return [...this.list.values()].map(({ failures: _f, level, ...d }) => ({
      ...d,
      battery: d.connected ? level : null,
      charging: false,
    }));
  }

  isScanning(): boolean {
    return this.scanning;
  }

  async startScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.emit('changed');
    for (const { delay, device } of CATALOG) {
      this.timers.push(
        setTimeout(() => {
          if (!this.scanning || this.list.has(device.address)) return;
          this.list.set(device.address, { ...device, paired: false, connected: false, battery: null, charging: false });
          this.emit('changed');
        }, delay),
      );
    }
  }

  async stopScan(): Promise<void> {
    if (!this.scanning) return;
    this.scanning = false;
    this.clearTimers();
    // Como no Bluetooth de verdade: o que não foi pareado some da lista depois da busca.
    for (const [address, d] of this.list) if (!d.paired) this.list.delete(address);
    this.emit('changed');
  }

  async pair(address: string): Promise<void> {
    const device = this.list.get(address);
    if (!device) throw new BluetoothError('Esse aparelho não está mais por perto. Procure de novo.');
    await sleep(1500);
    if (device.failures > 0) {
      device.failures--;
      throw new BluetoothError(`Não consegui parear ${device.name}. Coloque o controle em modo de pareamento e tente de novo.`);
    }
    device.paired = true;
    device.connected = true;
    this.emit('changed');
  }

  async forget(address: string): Promise<void> {
    this.list.delete(address);
    this.emit('changed');
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
