import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SCREENSHOT_ID_PATTERN,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_COUNT,
  type CartridgeManifest,
  type Screenshot,
} from '@playzin/shared';

/** Abaixo disso de espaço livre no disco, o console não grava mais capturas (os saves vêm antes). */
const MIN_FREE_BYTES = 200 * 1024 * 1024;
const MAX_THUMB_BYTES = 256 * 1024;
const MAX_SIDE = 4096;

/** O que fica no <id>.json, ao lado da imagem. */
interface ShotMeta {
  format: 1;
  id: string;
  game: string;
  gameName: string;
  profile: string | null;
  takenAt: string;
  width: number;
  height: number;
  bytes: number;
}

export class ScreenshotError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Álbum de capturas de tela do console (um só, como nos consoles: cada captura guarda quem
 * estava jogando, e excluir um perfil não apaga as fotos).
 *
 *   <pasta>/<id>.jpg        a captura
 *   <pasta>/<id>.thumb.jpg  miniatura para a grade (feita pelo launcher)
 *   <pasta>/<id>.json       jogo, perfil, data e tamanho
 *
 * O id começa pela data (base 36), então a ordem dos nomes já é a ordem das fotos.
 * O launcher é quem tira a foto (ele enxerga o canvas do jogo); o daemon só confere e guarda.
 */
export class ScreenshotStore {
  private cache: Map<string, ShotMeta> | null = null;

  constructor(private readonly dir: string) {}

  /** Mais recentes primeiro. */
  async list(): Promise<Screenshot[]> {
    const all = [...(await this.load()).values()];
    all.sort((a, b) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : b.id.localeCompare(a.id)));
    return all.map(toPublic);
  }

  async add(
    manifest: CartridgeManifest,
    profile: string | null,
    input: { image: Buffer; thumb: Buffer; width: unknown; height: unknown },
  ): Promise<Screenshot> {
    const { image, thumb } = input;
    if (!isJpeg(image) || !isJpeg(thumb)) throw new ScreenshotError('a captura precisa ser uma imagem JPEG');
    if (image.length > SCREENSHOT_MAX_BYTES) throw new ScreenshotError('captura grande demais', 413);
    if (thumb.length > MAX_THUMB_BYTES) throw new ScreenshotError('miniatura grande demais', 413);
    const width = Number(input.width);
    const height = Number(input.height);
    const sideOk = (n: number) => Number.isInteger(n) && n > 0 && n <= MAX_SIDE;
    if (!sideOk(width) || !sideOk(height)) throw new ScreenshotError('tamanho da captura inválido');

    const shots = await this.load();
    if (shots.size >= SCREENSHOT_MAX_COUNT) {
      throw new ScreenshotError(`Álbum cheio (${SCREENSHOT_MAX_COUNT} capturas): apague algumas em Capturas`, 507);
    }
    await fs.mkdir(this.dir, { recursive: true });
    if ((await freeBytes(this.dir)) < MIN_FREE_BYTES) {
      throw new ScreenshotError('Pouco espaço no console: apague algumas capturas', 507);
    }

    const now = new Date();
    const id = `s${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
    const meta: ShotMeta = {
      format: 1,
      id,
      game: manifest.id,
      gameName: manifest.name,
      profile,
      takenAt: now.toISOString(),
      width,
      height,
      bytes: image.length,
    };
    // Imagens primeiro, metadados por último: sem o .json, a captura não aparece (e não fica pela metade).
    await writeFileSynced(this.file(id, 'jpg'), image);
    await writeFileSynced(this.file(id, 'thumb.jpg'), thumb);
    await writeFileSynced(this.file(id, 'json'), Buffer.from(JSON.stringify(meta, null, 2)));
    shots.set(id, meta);
    return toPublic(meta);
  }

  async remove(id: string): Promise<boolean> {
    if (!SCREENSHOT_ID_PATTERN.test(id)) return false;
    const shots = await this.load();
    if (!shots.has(id)) return false;
    // O .json sai primeiro: se algo falhar depois, sobra só uma imagem órfã, nunca um item quebrado.
    await fs.rm(this.file(id, 'json'), { force: true });
    shots.delete(id);
    await fs.rm(this.file(id, 'jpg'), { force: true });
    await fs.rm(this.file(id, 'thumb.jpg'), { force: true });
    return true;
  }

  /** Caminho da imagem (ou da miniatura) de uma captura que existe; null se não existe. */
  async filePath(id: string, thumb: boolean): Promise<string | null> {
    if (!SCREENSHOT_ID_PATTERN.test(id) || !(await this.load()).has(id)) return null;
    return this.file(id, thumb ? 'thumb.jpg' : 'jpg');
  }

  private file(id: string, ext: 'jpg' | 'thumb.jpg' | 'json'): string {
    return path.join(this.dir, `${id}.${ext}`);
  }

  private async load(): Promise<Map<string, ShotMeta>> {
    if (this.cache) return this.cache;
    const shots = new Map<string, ShotMeta>();
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      /* álbum ainda vazio */
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!SCREENSHOT_ID_PATTERN.test(id)) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as ShotMeta;
        if (meta?.format === 1 && meta.id === id) shots.set(id, meta);
      } catch {
        /* metadado estragado: a captura fica de fora */
      }
    }
    this.cache = shots;
    return shots;
  }
}

function toPublic(meta: ShotMeta): Screenshot {
  const { format: _format, ...rest } = meta;
  return {
    ...rest,
    url: `/api/screenshots/${meta.id}.jpg`,
    thumbUrl: `/api/screenshots/${meta.id}.thumb.jpg`,
  };
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

async function writeFileSynced(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

async function freeBytes(dir: string): Promise<number> {
  try {
    const s = await fs.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.POSITIVE_INFINITY; // sem statfs: não dá para saber, então não bloqueia
  }
}
