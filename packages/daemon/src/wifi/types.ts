import { EventEmitter } from 'node:events';

/** Uma rede como o backend a enxerga (pode haver várias com o mesmo nome: um por roteador/banda). */
export interface RawNetwork {
  ssid: string;
  signal: number;
  secured: boolean;
}

export interface RawWifi {
  networks: RawNetwork[];
  /** Nomes das redes salvas no console. */
  known: string[];
  current: { ssid: string; signal: number; ip: string | null } | null;
  scanning: boolean;
}

export interface WifiBackendEvents {
  changed: [];
  error: [error: Error];
}

/**
 * Quem fala com o Wi-Fi de verdade. Implementações:
 * - NetworkManagerBackend: Raspberry Pi OS (Bookworm em diante), via D-Bus
 * - MockWifiBackend: Wi-Fi simulado, para testar a tela no PC
 */
export abstract class WifiBackend extends EventEmitter<WifiBackendEvents> {
  abstract readonly name: 'networkmanager' | 'mock';
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract snapshot(): RawWifi;
  abstract scan(): Promise<void>;
  /**
   * Conecta. Sem senha: usa a rede salva (ou rede aberta). Com senha: salva com a senha nova.
   * Resolve quando conectou; rejeita com WifiError (mensagem pronta para a TV).
   */
  abstract connect(ssid: string, password?: string): Promise<void>;
  abstract forget(ssid: string): Promise<void>;
}

export class WifiError extends Error {
  constructor(
    message: string,
    readonly wrongPassword = false,
  ) {
    super(message);
  }
}
