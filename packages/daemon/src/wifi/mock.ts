import { WifiBackend, WifiError, type RawNetwork, type RawWifi } from './types.js';

/** Senha das redes simuladas protegidas. */
export const MOCK_PASSWORD = 'playzin123';

const NETWORKS: RawNetwork[] = [
  { ssid: 'Casa do Diego', signal: 86, secured: true },
  { ssid: 'Casa do Diego', signal: 54, secured: true }, // mesmo nome, outro roteador (o console mostra uma vez só)
  { ssid: 'Vivo-Fibra-5G', signal: 71, secured: true },
  { ssid: 'NET_2G_A1B2', signal: 48, secured: true },
  { ssid: 'Cafeteria Livre', signal: 39, secured: false },
  { ssid: 'Vizinho 2.4', signal: 18, secured: true },
];

/**
 * Wi-Fi simulado para testar a tela no Mac/Windows. Não toca no Wi-Fi real do computador.
 * Começa conectado em "Casa do Diego". Redes protegidas aceitam a senha "playzin123";
 * qualquer outra dá "senha incorreta", para testar a mensagem de erro.
 */
export class MockWifiBackend extends WifiBackend {
  readonly name = 'mock' as const;
  private known = new Map<string, string | null>([['Casa do Diego', MOCK_PASSWORD]]);
  private current: string | null = 'Casa do Diego';
  private scanning = false;
  private jitter = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  snapshot(): RawWifi {
    const networks = NETWORKS.map((n, i) => ({ ...n, signal: clamp(n.signal + ((this.jitter + i * 7) % 9) - 4) }));
    const strongest = (ssid: string) => Math.max(...networks.filter((n) => n.ssid === ssid).map((n) => n.signal));
    return {
      networks,
      known: [...this.known.keys()],
      current: this.current ? { ssid: this.current, signal: strongest(this.current), ip: '192.168.0.42' } : null,
      scanning: this.scanning,
    };
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.emit('changed');
    await sleep(1500);
    this.jitter++;
    this.scanning = false;
    this.emit('changed');
  }

  async connect(ssid: string, password?: string): Promise<void> {
    const network = NETWORKS.find((n) => n.ssid === ssid);
    if (!network) throw new WifiError(`A rede “${ssid}” não está mais por perto.`);
    await sleep(1800);
    if (network.secured) {
      const saved = this.known.get(ssid);
      const attempt = password ?? saved ?? undefined;
      if (attempt === undefined) throw new WifiError(`A rede “${ssid}” precisa de senha.`, true);
      if (attempt !== MOCK_PASSWORD) {
        if (password !== undefined) this.known.delete(ssid);
        throw new WifiError(`Senha incorreta para “${ssid}”.`, true);
      }
    }
    this.known.set(ssid, password ?? this.known.get(ssid) ?? null);
    this.current = ssid;
    this.emit('changed');
  }

  async forget(ssid: string): Promise<void> {
    this.known.delete(ssid);
    if (this.current === ssid) this.current = null;
    this.emit('changed');
  }
}

function clamp(n: number): number {
  return Math.max(1, Math.min(100, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
