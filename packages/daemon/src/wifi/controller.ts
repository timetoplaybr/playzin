import { EventEmitter } from 'node:events';
import type { WifiNetwork, WifiState } from '@playzin/shared';
import { WifiError, type WifiBackend } from './types.js';

export interface WifiControllerEvents {
  state: [state: WifiState];
  connected: [ssid: string];
  error: [message: string, ssid: string | undefined, wrongPassword: boolean];
}

/**
 * Regras do console em cima do backend de Wi-Fi: uma conexão por vez, lista sem nomes
 * repetidos (fica o sinal mais forte), a rede conectada primeiro, depois as salvas e o
 * resto por força do sinal. Confere a senha antes de mandar para o sistema.
 */
export class WifiController extends EventEmitter<WifiControllerEvents> {
  private connecting: string | null = null;
  private stateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly backend: WifiBackend | null,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    super();
    backend?.on('changed', () => this.scheduleState());
    backend?.on('error', (err) => log.warn(`[wifi] ${err.message}`));
  }

  async start(): Promise<void> {
    await this.backend?.start();
  }

  async stop(): Promise<void> {
    clearTimeout(this.stateTimer);
    await this.backend?.stop();
  }

  state(): WifiState {
    if (!this.backend) {
      return { available: false, backend: 'none', scanning: false, connecting: null, current: null, networks: [] };
    }
    const raw = this.backend.snapshot();
    const known = new Set(raw.known);
    const bySsid = new Map<string, WifiNetwork>();
    for (const n of raw.networks) {
      const prev = bySsid.get(n.ssid);
      if (prev && prev.signal >= n.signal) continue;
      bySsid.set(n.ssid, {
        ssid: n.ssid,
        signal: n.signal,
        secured: n.secured,
        known: known.has(n.ssid),
        connected: raw.current?.ssid === n.ssid,
      });
    }
    const networks = [...bySsid.values()].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || Number(b.known) - Number(a.known) || b.signal - a.signal,
    );
    return {
      available: true,
      backend: this.backend.name,
      scanning: raw.scanning,
      connecting: this.connecting,
      current: raw.current,
      networks,
    };
  }

  async scan(): Promise<void> {
    if (!this.backend) throw new WifiError('Este console não controla o Wi-Fi.');
    await this.backend.scan();
  }

  /** Conecta em segundo plano: o resultado chega pelos eventos "connected" / "error". */
  connect(ssid: string, password?: string): void {
    if (!this.backend) throw new WifiError('Este console não controla o Wi-Fi.');
    if (this.connecting) throw new WifiError(`Já estou conectando em “${this.connecting}”. Espere terminar.`);
    const network = this.state().networks.find((n) => n.ssid === ssid);
    if (!network) throw new WifiError(`A rede “${ssid}” não está mais por perto. Procure de novo.`);
    if (password !== undefined && network.secured && (password.length < 8 || password.length > 63)) {
      throw new WifiError('A senha de redes Wi-Fi tem de 8 a 63 caracteres.', true);
    }
    if (network.secured && !network.known && password === undefined) {
      throw new WifiError(`A rede “${ssid}” precisa de senha.`, true);
    }

    this.connecting = ssid;
    this.scheduleState();
    void (async () => {
      try {
        await this.backend!.connect(ssid, password);
        this.log.info(`[wifi] conectado em ${ssid}`);
        this.emit('connected', ssid);
      } catch (err) {
        const e = err instanceof WifiError ? err : new WifiError(`Falha ao conectar: ${(err as Error).message}`);
        this.log.warn(`[wifi] ${ssid}: ${e.message}`);
        this.emit('error', e.message, ssid, e.wrongPassword);
      } finally {
        this.connecting = null;
        this.scheduleState();
      }
    })();
  }

  async forget(ssid: string): Promise<void> {
    if (!this.backend) throw new WifiError('Este console não controla o Wi-Fi.');
    await this.backend.forget(ssid);
    this.scheduleState();
  }

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.emit('state', this.state());
    }, 100);
  }
}
