import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE } from '@playzin/shared';
import { CartridgeSource, type WritableMedia } from './types.js';

/**
 * Observa pastas por polling. Cada subpasta imediata que contém um playzin.json
 * é tratada como um cartucho inserido; quando ela some, o cartucho foi removido.
 * Se o playzin.json de um cartucho presente muda (ex.: `playzin insert` de novo no dev-slot,
 * ou o pendrive regravado com o console ligado), conta como tirar e pôr a fita de volta:
 * o console lê a versão nova sem ninguém precisar ejetar antes.
 *
 * Polling (em vez de fs.watch) porque é previsível em macOS, Linux e Windows,
 * e funciona com pontos de montagem que aparecem e somem.
 */
export class DirectorySource extends CartridgeSource {
  readonly name = 'directory';
  /** Cartuchos presentes → impressão digital do playzin.json (para notar quando muda). */
  private present = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;

  constructor(
    private readonly roots: string[],
    private readonly intervalMs = 1000,
    /** Pastas que são, elas mesmas, um possível cartucho (raiz de unidade no Windows). */
    private readonly directRoots: string[] = [],
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

  /** Pastas e unidades do PC já aceitam escrita. */
  async openWritable(key: string): Promise<WritableMedia> {
    return { rootPath: key, close: async () => undefined };
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const found = new Map<string, string>();
      for (const root of this.directRoots) {
        // Unidade presente (pendrive no Windows): cartucho (tem playzin.json) ou pendrive comum,
        // que serve para o backup dos saves.
        const print = (await fingerprint(path.join(root, MANIFEST_FILE))) ?? ((await isDir(root)) ? 'pendrive' : undefined);
        if (print) found.set(root, print);
      }
      for (const root of this.roots) {
        for (const candidate of await listSubdirs(root)) {
          const print = await fingerprint(path.join(candidate, MANIFEST_FILE));
          if (print) found.set(candidate, print);
        }
      }
      for (const [key, print] of this.present) {
        // Sumiu, ou é outro cartucho no mesmo lugar: remove (e, se mudou, insere de novo abaixo).
        if (found.get(key) !== print) {
          this.present.delete(key);
          this.emit('removed', key);
        }
      }
      for (const key of [...found.keys()].sort()) {
        if (!this.present.has(key)) {
          this.present.set(key, found.get(key)!);
          this.emit('inserted', { key, rootPath: key, source: this.name, label: driveLabel(key) });
        }
      }
    } catch (err) {
      this.emit('error', err as Error);
    } finally {
      this.scanning = false;
    }
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** "E:\\" vira "Unidade E:"; uma pasta vira o nome dela. */
function driveLabel(key: string): string {
  const drive = /^([A-Za-z]):[\\/]?$/.exec(key);
  return drive ? `Unidade ${drive[1]!.toUpperCase()}:` : path.basename(key);
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

/**
 * "Impressão digital" do playzin.json: muda quando o arquivo é trocado (inode novo, como no
 * `playzin insert`, que copia para uma pasta nova e renomeia) ou regravado (data/tamanho).
 * undefined = não existe (não é um cartucho).
 */
async function fingerprint(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? `${stat.ino}:${stat.mtimeMs}:${stat.size}` : undefined;
  } catch {
    return undefined;
  }
}
