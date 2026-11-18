import fs from 'node:fs/promises';
import path from 'node:path';
import type { SaveSummary } from '@playzin/shared';

export type { SaveSummary };

/** Dados que o jogo guardou no localStorage (chave → valor, sempre texto). */
export type SaveData = Record<string, string>;

interface SaveFile {
  format: 1;
  gameId: string;
  name: string;
  gameVersion: string;
  updatedAt: string;
  data: SaveData;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_SAVE_BYTES = 5 * 1024 * 1024; // o mesmo limite do localStorage do navegador

/**
 * Saves dos jogos, guardados pelo console: um arquivo JSON por jogo.
 *
 * - Gravação atômica (arquivo temporário + fsync + rename): se a energia cair no meio,
 *   fica a versão anterior inteira, nunca um arquivo pela metade.
 * - A versão anterior também fica como <id>.json.bak, por segurança.
 * - "Apagar" grava dados vazios em vez de remover o arquivo: assim o console sabe que
 *   o jogo deve começar do zero (e não reaproveitar sobras do navegador).
 */
export class SaveStore {
  private queue = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Dados salvos do jogo, ou null se o console nunca guardou nada dele. */
  async read(id: string): Promise<SaveData | null> {
    const file = await this.readFile(id);
    return file ? file.data : null;
  }

  async write(id: string, meta: { name: string; gameVersion: string }, data: SaveData): Promise<void> {
    assertId(id);
    const body: SaveFile = {
      format: 1,
      gameId: id,
      name: meta.name,
      gameVersion: meta.gameVersion,
      updatedAt: new Date().toISOString(),
      data,
    };
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > MAX_SAVE_BYTES) throw new Error('save maior que o limite de 5 MB');
    // Gravações do mesmo jogo em fila: nunca duas ao mesmo tempo no mesmo arquivo.
    await this.serialize(id, () => this.atomicWrite(id, json));
  }

  /**
   * Dados que já estavam no navegador antes de o console guardar saves (versões antigas
   * do Playzin). Capturados uma única vez; cada jogo leva dali só as chaves que usa.
   */
  async readLegacy(): Promise<SaveData | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.legacyFile(), 'utf8')) as { data?: unknown };
      return isSaveData(parsed.data) ? parsed.data : {};
    } catch {
      return undefined;
    }
  }

  /** Grava o pool legado só se ele ainda não existir (a primeira captura vale). */
  async writeLegacyOnce(data: SaveData): Promise<boolean> {
    return this.serialize('_legacy', async () => {
      if ((await this.readLegacy()) !== undefined) return false;
      const json = JSON.stringify({ format: 1, capturedAt: new Date().toISOString(), data });
      if (Buffer.byteLength(json) > MAX_SAVE_BYTES) throw new Error('dados antigos maiores que 5 MB');
      const tmp = `${this.legacyFile()}.${process.pid}.tmp`;
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, this.legacyFile());
      return true;
    });
  }

  /** Apaga o progresso de um jogo (ele volta a começar do zero). */
  async clear(id: string): Promise<boolean> {
    const file = await this.readFile(id);
    if (!file || Object.keys(file.data).length === 0) return false;
    await this.write(id, { name: file.name, gameVersion: file.gameVersion }, {});
    return true;
  }

  /** Jogos com progresso salvo, mais recentes primeiro. */
  async list(): Promise<SaveSummary[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: SaveSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!ID_PATTERN.test(id)) continue;
      const file = await this.readFile(id);
      if (!file) continue;
      const keys = Object.keys(file.data).length;
      if (keys === 0) continue;
      out.push({
        id,
        name: file.name,
        gameVersion: file.gameVersion,
        updatedAt: file.updatedAt,
        bytes: Buffer.byteLength(JSON.stringify(file.data)),
        keys,
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async readFile(id: string): Promise<SaveFile | null> {
    assertId(id);
    for (const candidate of [this.fileFor(id), `${this.fileFor(id)}.bak`]) {
      try {
        const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as SaveFile;
        if (parsed && typeof parsed.data === 'object' && parsed.data !== null) return parsed;
      } catch {
        /* não existe ou corrompido: tenta o backup */
      }
    }
    return null;
  }

  private async atomicWrite(id: string, json: string): Promise<void> {
    const file = this.fileFor(id);
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(json);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch {
      /* primeira gravação: ainda não há o que guardar */
    }
    await fs.rename(tmp, file);
  }

  private serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queue.set(id, next);
    void next.finally(() => {
      if (this.queue.get(id) === next) this.queue.delete(id);
    }).catch(() => undefined);
    return next;
  }

  private legacyFile(): string {
    return path.join(this.dir, '_legacy.json');
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`id de jogo inválido: ${id}`);
}

export function isSaveData(value: unknown): value is SaveData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}
