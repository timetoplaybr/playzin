import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BACKUP_FOLDER,
  MANIFEST_FILE,
  PROFILE_COLORS,
  PROFILE_ICONS,
  type BackupContents,
  type BackupEntry,
  type BackupState,
  type ProfileColor,
  type ProfileIcon,
} from '@playzin/shared';
import type { CartridgeSource, DetectedMedia } from './sources/types.js';

/** O que vai em cada backup, além das pastas: para listar sem abrir tudo. */
const INFO_FILE = 'backup.json';
const PROFILES_FILE = 'profiles.json';
const SAVES_DIR = 'saves';
const SHOTS_DIR = 'screenshots';
/** Folga de espaço no pendrive, além do tamanho do backup. */
const SPACE_MARGIN = 2_000_000;

interface BackupInfoFile {
  format: 1;
  app: 'playzin';
  createdAt: string;
  systemVersion: string;
  reason: 'manual' | 'before-restore';
  withScreenshots: boolean;
  contents: BackupContents;
}

export interface BackupPaths {
  savesDir: string;
  profilesFile: string;
  screenshotsDir: string;
}

/** O que precisa ler tudo de novo depois de uma restauração. */
export interface Reloadable {
  reload(): void | Promise<void>;
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Drive {
  media: DetectedMedia;
  source: CartridgeSource;
}

export interface BackupEvents {
  state: [state: BackupState];
  /** Um pendrive comum entrou (a TV avisa que dá para fazer backup nele). */
  drive: [name: string];
}

/**
 * Backup dos saves num pendrive comum (sem jogo), e a volta.
 *
 * - O backup vai para PlayzinBackup/<data>/ no pendrive: perfis, saves (com tempo de jogo e
 *   conquistas de cada perfil) e, se quiser, as capturas. É gravado numa pasta .tmp e só ganha o
 *   nome final no fim: um pendrive puxado no meio não deixa um backup "pela metade" na lista.
 * - Restaurar substitui os dados deste console pelos do backup. Antes, o console faz um backup
 *   automático do que tem agora no mesmo pendrive (dá para voltar atrás). A troca é montada ao
 *   lado e feita de uma vez; depois os dados em memória são relidos.
 * Os arquivos ficam como estão no console (JSON e imagens): dá para abrir o backup num PC.
 */
export class BackupManager extends EventEmitter<BackupEvents> {
  private drives = new Map<string, Drive>();
  /** O pendrive em uso: o último que entrou. */
  private currentKey: string | null = null;
  private backups: BackupEntry[] = [];
  private freeBytes: number | null = null;
  private phase: BackupState['phase'] = 'idle';
  private progress = 0;
  private result: BackupState['result'] = null;
  private error: string | null = null;
  private lastEmit = 0;

  constructor(
    private readonly paths: BackupPaths,
    private readonly version: string,
    private readonly stores: Reloadable[],
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    super();
  }

  /** Escuta as mesmas fontes dos cartuchos: o que não tem playzin.json é um pendrive comum. */
  attach(source: CartridgeSource): void {
    source.on('inserted', (media) => void this.onInserted(media, source));
    source.on('removed', (key) => void this.onRemoved(key));
  }

  private async onInserted(media: DetectedMedia, source: CartridgeSource): Promise<void> {
    if (await exists(path.join(media.rootPath, MANIFEST_FILE))) return; // é um cartucho
    this.drives.set(media.key, { media, source });
    this.currentKey = media.key;
    this.error = null;
    this.result = null;
    await this.refreshDrive();
    this.log.info(`[backup] pendrive conectado: ${driveName(media)} (${this.backups.length} backup(s) nele)`);
    this.emit('drive', driveName(media));
    await this.emitState();
  }

  private async onRemoved(key: string): Promise<void> {
    if (!this.drives.delete(key)) return;
    if (this.currentKey === key) {
      this.currentKey = [...this.drives.keys()].at(-1) ?? null;
      await this.refreshDrive();
    }
    await this.emitState();
  }

  private get drive(): Drive | null {
    return this.currentKey ? (this.drives.get(this.currentKey) ?? null) : null;
  }

  // ---------------------------------------------------------------- estado

  async getState(): Promise<BackupState> {
    const d = this.drive;
    return {
      drive: d ? { name: driveName(d.media), freeBytes: this.freeBytes } : null,
      backups: this.backups,
      current: await this.currentContents(true).catch(() => null),
      phase: this.phase,
      progress: this.progress,
      result: this.result,
      error: this.error,
    };
  }

  private async emitState(throttled = false): Promise<void> {
    const now = Date.now();
    if (throttled && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.emit('state', await this.getState());
  }

  /** Lê os backups do pendrive e o espaço livre. */
  private async refreshDrive(): Promise<void> {
    const d = this.drive;
    if (!d) {
      this.backups = [];
      this.freeBytes = null;
      return;
    }
    this.freeBytes = await freeBytes(d.media.rootPath);
    this.backups = await listBackups(d.media.rootPath);
  }

  /** O que há neste console agora (com ou sem as capturas no tamanho total). */
  private async currentContents(withScreenshots: boolean): Promise<BackupContents> {
    return contentsOf(this.paths.profilesFile, this.paths.savesDir, this.paths.screenshotsDir, withScreenshots);
  }

  // ---------------------------------------------------------------- backup

  /** Faz o backup no pendrive conectado. Resolve quando termina (o progresso vai pelo WebSocket). */
  async create(withScreenshots: boolean): Promise<BackupState> {
    this.start('backing-up');
    try {
      const id = await this.writeBackup(withScreenshots, 'manual');
      this.result = { kind: 'backup', at: new Date().toISOString(), id };
      this.log.info(`[backup] backup feito: ${id}`);
    } catch (err) {
      this.fail(err);
    } finally {
      await this.finish();
    }
    return this.getState();
  }

  private async writeBackup(withScreenshots: boolean, reason: BackupInfoFile['reason']): Promise<string> {
    const d = this.requireDrive();
    const contents = await this.currentContents(withScreenshots);
    if (contents.profiles.length === 0 && contents.games === 0) throw new BackupError('Não há nada para guardar ainda: nenhum perfil neste console.');
    const sources: [string, string][] = [[this.paths.savesDir, SAVES_DIR]];
    if (withScreenshots) sources.push([this.paths.screenshotsDir, SHOTS_DIR]);
    const files: { from: string; to: string; size: number }[] = [];
    if (await exists(this.paths.profilesFile)) {
      files.push({ from: this.paths.profilesFile, to: PROFILES_FILE, size: (await fs.stat(this.paths.profilesFile)).size });
    }
    for (const [dir, target] of sources) {
      for (const f of await walk(dir)) files.push({ from: path.join(dir, f.rel), to: path.join(target, f.rel), size: f.size });
    }
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const free = await freeBytes(d.media.rootPath);
    if (free !== null && free < total + SPACE_MARGIN) {
      throw new BackupError(`Falta espaço no pendrive: o backup precisa de ${mb(total + SPACE_MARGIN)} e há ${mb(free)} livres.`);
    }

    const writable = await d.source.openWritable(d.media.key).catch((err: Error) => {
      throw new BackupError(`Não consegui gravar no pendrive: ${err.message}`);
    });
    let id = '';
    try {
      const folder = path.join(writable.rootPath, BACKUP_FOLDER);
      await fs.mkdir(folder, { recursive: true });
      await removeLeftovers(folder);
      id = await freeName(folder, stamp(new Date()));
      const temp = path.join(folder, `${id}.tmp`);
      let copied = 0;
      for (const f of files) {
        const target = path.join(temp, f.to);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(f.from, target);
        copied += f.size;
        this.progress = total ? copied / total : 1;
        await this.emitState(true);
      }
      const info: BackupInfoFile = {
        format: 1,
        app: 'playzin',
        createdAt: new Date().toISOString(),
        systemVersion: this.version,
        reason,
        withScreenshots,
        contents,
      };
      await fs.writeFile(path.join(temp, INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
      // Só agora vira um backup de verdade (a lista ignora as pastas .tmp).
      await fs.rename(temp, path.join(folder, id));
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError(
        (await exists(writable.rootPath))
          ? `Não consegui gravar no pendrive: ${(err as Error).message}`
          : 'O pendrive saiu no meio da cópia: o backup não foi feito.',
      );
    } finally {
      // Desmonta e monta de novo (no Pi): grava tudo no pendrive de vez antes de liberar.
      const root = await writable.close().catch(() => undefined);
      if (root) d.media.rootPath = root;
    }
    await this.refreshDrive();
    return id;
  }

  // ---------------------------------------------------------------- restaurar

  /** Troca os dados deste console pelos do backup `id` (antes, guarda os atuais no pendrive). */
  async restore(id: string): Promise<BackupState> {
    this.start('restoring');
    try {
      const entry = this.backups.find((b) => b.id === id);
      if (!entry) throw new BackupError('Esse backup não está mais no pendrive.', 404);
      const d = this.requireDrive();
      const source = path.join(d.media.rootPath, BACKUP_FOLDER, id);
      if (!(await exists(path.join(source, PROFILES_FILE)))) throw new BackupError('Esse backup está incompleto (faltam os perfis): não vou restaurar.');

      // 1. O que há agora vai para o pendrive antes (dá para desfazer restaurando essa cópia).
      const hasData = (await this.currentContents(false)).profiles.length > 0;
      if (hasData) {
        const safety = await this.writeBackup(entry.withScreenshots, 'before-restore');
        this.log.info(`[backup] cópia do que havia antes de restaurar: ${safety}`);
      }
      const from = path.join(this.drive!.media.rootPath, BACKUP_FOLDER, id); // pode ter mudado ao montar de novo

      // 2. Monta os dados novos ao lado dos atuais.
      const swaps: [string, string, boolean][] = [
        [path.join(from, PROFILES_FILE), this.paths.profilesFile, false],
        [path.join(from, SAVES_DIR), this.paths.savesDir, true],
      ];
      if (entry.withScreenshots) swaps.push([path.join(from, SHOTS_DIR), this.paths.screenshotsDir, true]);
      const files = [];
      for (const [src, , isDir] of swaps) {
        if (!isDir) continue;
        for (const f of await walk(src)) files.push(f.size);
      }
      const total = files.reduce((a, b) => a + b, 0) || 1;
      let copied = 0;
      for (const [src, dest, isDir] of swaps) {
        const staging = `${dest}.restaurando`;
        await fs.rm(staging, { recursive: true, force: true });
        if (!isDir) {
          await fs.copyFile(src, staging);
          continue;
        }
        await fs.mkdir(staging, { recursive: true });
        for (const f of await walk(src)) {
          const target = path.join(staging, f.rel);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(src, f.rel), target);
          copied += f.size;
          this.progress = 0.5 + (copied / total) * 0.5;
          await this.emitState(true);
        }
      }

      // 3. Troca de uma vez (o antigo só é apagado depois que o novo está no lugar).
      for (const [, dest] of swaps) {
        const old = `${dest}.antes-de-restaurar`;
        await fs.rm(old, { recursive: true, force: true });
        if (await exists(dest)) await fs.rename(dest, old);
        await fs.rename(`${dest}.restaurando`, dest);
      }
      for (const [, dest] of swaps) await fs.rm(`${dest}.antes-de-restaurar`, { recursive: true, force: true });
      // As cópias .bak dos perfis são do console de antes: não podem voltar no lugar dos restaurados.
      await fs.rm(`${this.paths.profilesFile}.bak`, { force: true });

      // 4. Tudo que estava em memória lê de novo.
      for (const store of this.stores) await store.reload();
      this.result = { kind: 'restore', at: new Date().toISOString(), id };
      this.log.info(`[backup] restaurado: ${id}`);
    } catch (err) {
      this.fail(err);
    } finally {
      await this.finish();
    }
    return this.getState();
  }

  // ---------------------------------------------------------------- ajudantes

  private requireDrive(): Drive {
    const d = this.drive;
    if (!d) throw new BackupError('Coloque um pendrive (sem jogo) no console.', 409);
    return d;
  }

  private start(phase: BackupState['phase']): void {
    if (this.phase !== 'idle') throw new BackupError('Já estou fazendo um backup. Espere terminar.', 409);
    this.requireDrive(); // antes de mudar a fase: sem pendrive, nada fica "copiando" para sempre
    this.phase = phase;
    this.progress = 0;
    this.error = null;
    this.result = null;
    void this.emitState();
  }

  private fail(err: unknown): void {
    this.error = err instanceof BackupError ? err.message : `Algo deu errado: ${(err as Error).message}`;
    this.log.warn(`[backup] ${this.error}`);
  }

  private async finish(): Promise<void> {
    this.phase = 'idle';
    this.progress = 0;
    await this.refreshDrive().catch(() => undefined);
    await this.emitState();
  }
}

// ---------------------------------------------------------------- arquivos

/** Todos os arquivos de uma pasta (relativos), sem temporários nem cópias .bak. */
async function walk(dir: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  async function visit(rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await visit(child);
      else if (e.isFile() && !/\.(tmp|bak)$/.test(e.name)) out.push({ rel: child, size: (await fs.stat(path.join(dir, child))).size });
    }
  }
  await visit('');
  return out;
}

/** O que há num conjunto de perfis/saves/capturas (do console ou de um backup). */
async function contentsOf(profilesFile: string, savesDir: string, shotsDir: string, withScreenshots: boolean): Promise<BackupContents> {
  const profiles: BackupContents['profiles'] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(profilesFile, 'utf8')) as { profiles?: { name?: unknown; icon?: unknown; color?: unknown }[] };
    for (const p of parsed.profiles ?? []) {
      if (typeof p.name !== 'string') continue;
      profiles.push({
        name: p.name,
        icon: (PROFILE_ICONS as readonly string[]).includes(String(p.icon)) ? (p.icon as ProfileIcon) : 'star',
        color: (PROFILE_COLORS as readonly string[]).includes(String(p.color)) ? (p.color as ProfileColor) : 'ocean',
      });
    }
  } catch {
    /* sem perfis */
  }
  const saves = await walk(savesDir);
  // Um save por jogo em cada perfil: <perfil>/<jogo>.json (os que começam com "_" são do console).
  const games = saves.filter((f) => f.rel.split(/[\\/]/).length === 2 && /^[a-z0-9][a-z0-9._-]*\.json$/.test(path.basename(f.rel))).length;
  const shots = await walk(shotsDir);
  const screenshotBytes = shots.reduce((sum, f) => sum + f.size, 0);
  const saveBytes = saves.reduce((sum, f) => sum + f.size, 0);
  return {
    profiles,
    games,
    screenshots: shots.filter((f) => f.rel.endsWith('.json')).length,
    screenshotBytes,
    bytes: saveBytes + (withScreenshots ? screenshotBytes : 0),
  };
}

/** Backups de um pendrive, os mais novos primeiro (pastas .tmp, de cópias interrompidas, ficam de fora). */
async function listBackups(root: string): Promise<BackupEntry[]> {
  const folder = path.join(root, BACKUP_FOLDER);
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const id of names) {
    if (id.endsWith('.tmp')) continue;
    try {
      const info = JSON.parse(await fs.readFile(path.join(folder, id, INFO_FILE), 'utf8')) as Partial<BackupInfoFile>;
      if (info.app !== 'playzin' || info.format !== 1 || !info.contents) continue;
      out.push({
        id,
        createdAt: String(info.createdAt ?? ''),
        systemVersion: String(info.systemVersion ?? '?'),
        reason: info.reason === 'before-restore' ? 'before-restore' : 'manual',
        withScreenshots: Boolean(info.withScreenshots),
        contents: info.contents,
      });
    } catch {
      /* pasta que não é um backup do Playzin */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Apaga cópias interrompidas (.tmp) de vezes anteriores. */
async function removeLeftovers(folder: string): Promise<void> {
  for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
    if (name.endsWith('.tmp')) await fs.rm(path.join(folder, name), { recursive: true, force: true });
  }
}

/** "2026-11-27_153012" (sem ":", que pendrives FAT não aceitam). */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function freeName(folder: string, base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!(await exists(path.join(folder, name)))) return name;
  }
}

function driveName(media: DetectedMedia): string {
  return media.label || path.basename(media.rootPath) || media.rootPath;
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function mb(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1_000_000))} MB`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
