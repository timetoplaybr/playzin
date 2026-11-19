import { EventEmitter } from 'node:events';
import type { BluetoothDevice, BluetoothState } from '@playzin/shared';
import { BluetoothError, type BluetoothBackend } from './types.js';

const SCAN_DURATION_MS = 60_000;
const AUTO_PAIR_DURATION_MS = 5 * 60_000;
const AUTO_RETRY_SAME_DEVICE_MS = 15_000;

export interface ControllerEvents {
  state: [state: BluetoothState];
  paired: [device: BluetoothDevice, auto: boolean];
  error: [message: string, address?: string];
}

/**
 * Regras do console em cima do backend de Bluetooth:
 * - a busca manual desliga sozinha depois de 1 minuto;
 * - um pareamento por vez;
 * - pareamento automático: se o console liga sem nenhum controle conhecido, ele procura
 *   por até 5 minutos e pareia o primeiro controle que aparecer em modo de pareamento.
 */
export class BluetoothController extends EventEmitter<ControllerEvents> {
  private manualScan = false;
  private scanTimer: NodeJS.Timeout | undefined;
  private autoPair = false;
  private autoTimer: NodeJS.Timeout | undefined;
  private autoTried = new Map<string, number>();
  private pairing = new Set<string>();
  private stateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly backend: BluetoothBackend | null,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    super();
    backend?.on('changed', () => {
      this.scheduleState();
      if (this.autoPair) void this.tryAutoPair();
    });
    backend?.on('error', (err) => log.warn(`[bluetooth] ${err.message}`));
  }

  get available(): boolean {
    return this.backend !== null;
  }

  async start(options: { autoPair: boolean }): Promise<void> {
    if (!this.backend) return;
    await this.backend.start();
    const hasGamepad = this.backend.devices().some((d) => d.paired && d.kind === 'gamepad');
    if (options.autoPair && !hasGamepad) {
      this.log.info('[bluetooth] nenhum controle pareado: pareamento automático ligado por 5 minutos');
      await this.setAutoPair(true);
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.scanTimer);
    clearTimeout(this.autoTimer);
    await this.backend?.stop();
  }

  state(): BluetoothState {
    if (!this.backend) return { available: false, backend: 'none', scanning: false, autoPair: false, devices: [] };
    const devices: BluetoothDevice[] = this.backend
      .devices()
      .filter((d) => d.paired || d.kind !== 'other')
      .map((d) => ({ ...d, pairing: this.pairing.has(d.address) }))
      .sort((a, b) => Number(b.paired) - Number(a.paired) || kindOrder(a) - kindOrder(b) || a.name.localeCompare(b.name));
    return {
      available: true,
      backend: this.backend.name,
      scanning: this.backend.isScanning() || this.manualScan || this.autoPair,
      autoPair: this.autoPair,
      devices,
    };
  }

  /** Liga/desliga a busca pedida pela tela de controles. */
  async setScan(on: boolean): Promise<void> {
    if (!this.backend) throw new BluetoothError('Este console não tem Bluetooth.');
    this.manualScan = on;
    clearTimeout(this.scanTimer);
    if (on) {
      this.scanTimer = setTimeout(() => void this.setScan(false), SCAN_DURATION_MS);
      await this.backend.startScan();
    } else if (!this.autoPair && this.pairing.size === 0) {
      await this.backend.stopScan();
    }
    this.scheduleState();
  }

  async setAutoPair(on: boolean): Promise<void> {
    if (!this.backend) return;
    this.autoPair = on;
    clearTimeout(this.autoTimer);
    if (on) {
      this.autoTimer = setTimeout(() => {
        this.log.info('[bluetooth] pareamento automático encerrado (tempo esgotado)');
        void this.setAutoPair(false);
      }, AUTO_PAIR_DURATION_MS);
      await this.backend.startScan();
      void this.tryAutoPair();
    } else if (!this.manualScan && this.pairing.size === 0) {
      await this.backend.stopScan();
    }
    this.scheduleState();
  }

  /** Pareia em segundo plano: o resultado chega pelos eventos "paired" / "error". */
  pair(address: string, auto = false): void {
    if (!this.backend) throw new BluetoothError('Este console não tem Bluetooth.');
    if (this.pairing.has(address)) return;
    if (this.pairing.size > 0) throw new BluetoothError('Já estou pareando outro aparelho. Espere terminar.');
    this.pairing.add(address);
    this.scheduleState();
    void (async () => {
      try {
        await this.backend!.pair(address);
        const device = this.state().devices.find((d) => d.address === address);
        this.log.info(`[bluetooth] pareado: ${device?.name ?? address}${auto ? ' (automático)' : ''}`);
        if (device) this.emit('paired', { ...device, pairing: false }, auto);
        if (auto) await this.setAutoPair(false);
      } catch (err) {
        const message = err instanceof BluetoothError ? err.message : `Falha no pareamento: ${(err as Error).message}`;
        this.log.warn(`[bluetooth] ${message}`);
        if (!auto) this.emit('error', message, address);
      } finally {
        this.pairing.delete(address);
        // A busca pode ter sido pausada para parear: retoma se ainda for preciso, ou desliga se não.
        const wantScan = this.manualScan || this.autoPair;
        if (wantScan && !this.backend!.isScanning()) await this.backend!.startScan().catch(() => undefined);
        if (!wantScan && this.backend!.isScanning()) await this.backend!.stopScan().catch(() => undefined);
        this.scheduleState();
      }
    })();
  }

  async forget(address: string): Promise<void> {
    if (!this.backend) throw new BluetoothError('Este console não tem Bluetooth.');
    await this.backend.forget(address);
    this.scheduleState();
  }

  private async tryAutoPair(): Promise<void> {
    if (!this.autoPair || !this.backend || this.pairing.size > 0) return;
    const now = Date.now();
    const candidate = this.backend
      .devices()
      .find((d) => d.kind === 'gamepad' && !d.paired && now - (this.autoTried.get(d.address) ?? 0) > AUTO_RETRY_SAME_DEVICE_MS);
    if (!candidate) return;
    this.autoTried.set(candidate.address, now);
    this.log.info(`[bluetooth] pareamento automático: tentando ${candidate.name}`);
    this.pair(candidate.address, true);
  }

  /** Junta várias mudanças seguidas num aviso só para a TV. */
  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.emit('state', this.state());
    }, 100);
  }
}

function kindOrder(d: BluetoothDevice): number {
  return { gamepad: 0, keyboard: 1, mouse: 2, other: 3 }[d.kind];
}
