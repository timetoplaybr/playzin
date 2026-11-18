import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE } from '@playzin/shared';
import { CartridgeSource } from './types.js';

/**
 * Observa pastas por polling. Cada subpasta imediata que contém um playzin.json
 * é tratada como um cartucho inserido; quando ela some, o cartucho foi removido.
 *
 * Polling (em vez de fs.watch) porque é previsível em macOS, Linux e Windows,
 * e funciona com pontos de montagem que aparecem e somem.
 */
export class DirectorySource extends CartridgeSource {
  readonly name = 'directory';
  private present = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    private readonly roots: string[],
    private readonly intervalMs = 1000,
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const found = new Set<string>();
      for (const root of this.roots) {
        for (const candidate of await listSubdirs(root)) {
          if (await fileExists(path.join(candidate, MANIFEST_FILE))) found.add(candidate);
        }
      }
      for (const key of this.present) {
        if (!found.has(key)) {
          this.present.delete(key);
          this.emit('removed', key);
        }
      }
      for (const key of [...found].sort()) {
        if (!this.present.has(key)) {
          this.present.add(key);
          this.emit('inserted', { key, rootPath: key, source: this.name });
        }
      }
    } catch (err) {
      this.emit('error', err as Error);
    } finally {
      this.scanning = false;
    }
  }
}

async function listSubdirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => path.join(root, e.name));
  } catch {
    return []; // pasta ainda não existe ou sem permissão: simplesmente nada inserido
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}
