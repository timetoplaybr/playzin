import { EventEmitter } from 'node:events';

/** Algo que foi "plugado" e cuja raiz pode conter um playzin.json. */
export interface DetectedMedia {
  /** Chave estável enquanto a mídia estiver presente (ex.: caminho ou objeto D-Bus). */
  key: string;
  /** Pasta onde a mídia está acessível (ponto de montagem). */
  rootPath: string;
  /** Nome da fonte que detectou (para logs). */
  source: string;
  /** Nome do pendrive (rótulo do sistema de arquivos), quando houver. */
  label?: string;
}

/**
 * Um pendrive aberto para escrita (o backup grava nele). `close` devolve ao modo de antes e diz
 * onde ele ficou montado (pode mudar ao montar de novo), ou undefined se não mudou.
 */
export interface WritableMedia {
  rootPath: string;
  close(): Promise<string | undefined>;
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
  /**
   * Abre a mídia para escrita (backup dos saves). No Pi os pendrives ficam montados como somente
   * leitura (puxar no meio não estraga nada): só durante a gravação eles aceitam escrita.
   */
  abstract openWritable(key: string): Promise<WritableMedia>;
}
