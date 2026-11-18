import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CARTRIDGE_URL_PREFIX,
  MANIFEST_FILE,
  validateManifest,
  type CartridgeInfo,
  type CartridgeManifest,
} from '@playzin/shared';
import type { CartridgeSource, DetectedMedia } from './sources/types.js';

interface LoadedCartridge {
  media: DetectedMedia;
  info: CartridgeInfo;
  rootPath: string;
}

export interface CartridgeManagerEvents {
  inserted: [info: CartridgeInfo];
  removed: [slotId: string];
  error: [message: string, source: string];
}

/**
 * Recebe eventos "mídia plugada/removida" das fontes, valida o playzin.json
 * e mantém qual cartucho está ativo. O console tem um slot só: se houver mais
 * de um cartucho, o primeiro inserido vale e os outros ficam na fila.
 */
export class CartridgeManager extends EventEmitter<CartridgeManagerEvents> {
  private loaded = new Map<string, LoadedCartridge>();
  private activeKey: string | undefined;
  private counter = 0;
  /** Todo slot emitido nesta sessão → manifesto. O jogo ainda pode salvar logo depois do cartucho sair. */
  private issued = new Map<string, CartridgeManifest>();

  constructor(private readonly log: { info: (msg: string) => void; warn: (msg: string) => void }) {
    super();
  }

  attach(source: CartridgeSource): void {
    source.on('inserted', (media) => void this.onInserted(media));
    source.on('removed', (key) => this.onRemoved(key));
    source.on('error', (err) => this.log.warn(`[${source.name}] ${err.message}`));
  }

  get current(): CartridgeInfo | null {
    return this.activeKey ? (this.loaded.get(this.activeKey)?.info ?? null) : null;
  }

  /** Resolve um arquivo do cartucho ativo de forma segura (sem escapar da raiz). */
  resolveFile(slotId: string, relativePath: string): string | undefined {
    const active = this.activeKey ? this.loaded.get(this.activeKey) : undefined;
    if (!active || active.info.slotId !== slotId) return undefined;
    const root = path.resolve(active.rootPath);
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + path.sep)) return undefined;
    return target;
  }

  /** Manifesto de um slot emitido nesta sessão (ativo ou já removido). */
  manifestForSlot(slotId: string): CartridgeManifest | undefined {
    return this.issued.get(slotId);
  }

  activeRoot(slotId: string): string | undefined {
    const active = this.activeKey ? this.loaded.get(this.activeKey) : undefined;
    return active && active.info.slotId === slotId ? active.rootPath : undefined;
  }

  private async onInserted(media: DetectedMedia): Promise<void> {
    const manifestPath = path.join(media.rootPath, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
      // Pendrive comum, sem playzin.json: não é um cartucho. Ignora em silêncio.
      this.log.info(`[${media.source}] mídia sem ${MANIFEST_FILE} ignorada: ${media.rootPath}`);
      return;
    }

    let manifest: CartridgeManifest;
    try {
      const result = validateManifest(JSON.parse(raw));
      if (!result.ok || !result.manifest) throw new Error(result.errors.join('; '));
      manifest = result.manifest;
      await assertFile(path.join(media.rootPath, manifest.entry), `arquivo de entrada "${manifest.entry}"`);
      if (manifest.cover) {
        try {
          await assertFile(path.join(media.rootPath, manifest.cover), 'capa');
        } catch {
          this.log.warn(`capa "${manifest.cover}" não encontrada em ${media.rootPath}; seguindo sem capa`);
          delete manifest.cover;
        }
      }
    } catch (err) {
      const message = `Cartucho inválido em ${media.rootPath}: ${(err as Error).message}`;
      this.log.warn(message);
      this.emit('error', message, media.source);
      return;
    }

    // A mídia pode ter sido removida enquanto líamos o manifesto.
    if (this.loaded.has(media.key)) return;

    const slotId = `${manifest.id}-${++this.counter}`;
    const base = `${CARTRIDGE_URL_PREFIX}/${encodeURIComponent(slotId)}/`;
    const info: CartridgeInfo = {
      manifest,
      slotId,
      entryUrl: base + encodePath(manifest.entry),
      coverUrl: manifest.cover ? base + encodePath(manifest.cover) : undefined,
      insertedAt: new Date().toISOString(),
    };
    this.loaded.set(media.key, { media, info, rootPath: media.rootPath });
    this.issued.set(slotId, manifest);
    this.log.info(`cartucho detectado: ${manifest.name} v${manifest.version} (${media.rootPath})`);

    if (!this.activeKey) this.activate(media.key);
  }

  private onRemoved(key: string): void {
    const entry = this.loaded.get(key);
    if (!entry) return;
    this.loaded.delete(key);
    this.log.info(`cartucho removido: ${entry.info.manifest.name}`);

    if (this.activeKey === key) {
      this.activeKey = undefined;
      this.emit('removed', entry.info.slotId);
      // Se havia outro cartucho esperando, ele assume o slot.
      const next = this.loaded.keys().next();
      if (!next.done) this.activate(next.value);
    }
  }

  private activate(key: string): void {
    const entry = this.loaded.get(key);
    if (!entry) return;
    this.activeKey = key;
    this.emit('inserted', entry.info);
  }
}

async function assertFile(file: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new Error(`${label} não encontrado`);
  }
  if (!stat.isFile()) throw new Error(`${label} não é um arquivo`);
}

function encodePath(p: string): string {
  return p.split(/[\\/]/).map(encodeURIComponent).join('/');
}
