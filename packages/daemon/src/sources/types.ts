import { EventEmitter } from 'node:events';

/** Algo que foi "plugado" e cuja raiz pode conter um playzin.json. */
export interface DetectedMedia {
  /** Chave estável enquanto a mídia estiver presente (ex.: caminho ou objeto D-Bus). */
  key: string;
  /** Pasta onde a mídia está acessível (ponto de montagem). */
  rootPath: string;
  /** Nome da fonte que detectou (para logs). */
  source: string;
}

export interface CartridgeSourceEvents {
  inserted: [media: DetectedMedia];
  removed: [key: string];
  error: [error: Error];
}

/**
 * Uma fonte de cartuchos. Implementações:
 * - DirectorySource: observa pastas (dev-slot, /Volumes no Mac, /media no Linux)
 * - UdisksSource: escuta o UDisks2 via D-Bus e monta pendrives (Raspberry Pi)
 */
export abstract class CartridgeSource extends EventEmitter<CartridgeSourceEvents> {
  abstract readonly name: string;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}
