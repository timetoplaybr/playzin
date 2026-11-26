import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateRelease, UpdateState } from '@playzin/shared';
import { RELEASE_PUBLIC_KEY, signedMessage } from './public-key.js';

/** Depois de instalar, a versão nova tem este tempo para a TV abrir; senão, volta para a anterior. */
const TRIAL_MS = 120_000;
const FIRST_CHECK_MS = 90_000;
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
/** Espaço livre exigido: pacote baixado + extraído (com folga). */
const SPACE_FACTOR = 5;

export interface UpdaterOptions {
  /** auto = só no console de verdade (instalado em <raiz>/releases/<versão>); off = desligado; force = testes. */
  mode: 'auto' | 'off' | 'force';
  /** Endereço do latest.json (o GitHub Releases do projeto). */
  url: string;
  /** /opt/playzin: tem releases/<versão>/ e o link current → releases/<versão>. */
  installRoot: string;
  /** /var/lib/playzin/update: pending, attempts, failed, last-update. */
  stateDir: string;
  /** Pasta da versão que está rodando agora. */
  appRoot: string;
  /** Tempo para a TV conectar depois de instalar (padrão 2 min; menor só em testes). */
  trialMs?: number;
}

/** O latest.json publicado junto de cada versão. */
interface Manifest extends UpdateRelease {
  url: string;
  sha256: string;
  signature: string;
}

export interface UpdaterEvents {
  state: [state: UpdateState];
  /** Versão nova no lugar: o daemon precisa sair para o systemd subir a versão nova. */
  restart: [version: string];
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Atualização do sistema pelo Wi-Fi, com confirmação na TV.
 *
 * 1. Procura: baixa o latest.json e confere a assinatura (ed25519) antes de mostrar a versão.
 * 2. Baixa o pacote ao lado (releases/.incoming), confere o sha256 e extrai em releases/<versão>.
 * 3. Instala (depois do "A de novo" na TV): guarda qual era a versão anterior, troca o link current
 *    de uma vez só (um corte de energia no meio deixa a versão antiga ou a nova, nunca metade) e sai;
 *    o systemd sobe o daemon de novo, já na versão nova.
 * 4. A versão nova fica "em teste" até a TV abrir e se conectar. Não abriu em 2 minutos: volta sozinha
 *    para a anterior. Não consegue nem subir: o update-guard.sh (antes de cada início do serviço)
 *    volta para a anterior depois de 3 tentativas.
 * Saves, perfis e configurações (/var/lib/playzin) ficam fora e não são tocados.
 */
export class Updater extends EventEmitter<UpdaterEvents> {
  private readonly version: string;
  private manifest: Manifest | null = null;
  private state: UpdateState;
  private trialTimer: NodeJS.Timeout | undefined;
  private checkTimer: NodeJS.Timeout | undefined;
  private inTrial = false;
  private lastEmit = 0;

  constructor(
    private readonly options: UpdaterOptions,
    version: string,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    super();
    this.version = version;
    this.state = {
      version,
      supported: false,
      problem: 'Verificando…',
      phase: 'idle',
      available: null,
      progress: 0,
      lastCheckedAt: null,
      error: null,
      justUpdated: null,
      rolledBack: null,
    };
  }

  private get releasesDir(): string {
    return path.join(this.options.installRoot, 'releases');
  }

  private get currentLink(): string {
    return path.join(this.options.installRoot, 'current');
  }

  private file(name: 'pending' | 'attempts' | 'failed' | 'last-update'): string {
    return path.join(this.options.stateDir, name);
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  // ---------------------------------------------------------------- início

  async start(): Promise<void> {
    const problem = await this.unsupportedReason();
    this.state.supported = problem === null;
    this.state.problem = problem;
    if (problem) {
      this.emitState();
      return;
    }
    await fs.mkdir(this.options.stateDir, { recursive: true });

    // O update-guard.sh (ou o próprio daemon) voltou para a versão anterior.
    const failed = await readJson<{ from: string; to: string }>(this.file('failed'));
    if (failed) {
      this.state.rolledBack = failed;
      await fs.rm(this.file('failed'), { force: true });
      this.log.warn(`[atualização] a versão ${failed.from} não funcionou: voltei para ${failed.to}`);
      // A versão que falhou sai do cartão (senão a limpeza guardaria ela no lugar da última boa).
      const running = path.basename(await fs.realpath(this.currentLink).catch(() => ''));
      if (/^\d+\.\d+\.\d+/.test(failed.from) && failed.from !== running) {
        await fs.rm(path.join(this.releasesDir, failed.from), { recursive: true, force: true });
      }
    }

    // Acabou de instalar: fica em teste até a TV conectar.
    if (await exists(this.file('pending'))) {
      this.inTrial = true;
      this.log.info(`[atualização] versão ${this.version} em teste: esperando a TV abrir`);
      this.trialTimer = setTimeout(() => void this.rollback('a tela da TV não abriu'), this.options.trialMs ?? TRIAL_MS);
    } else {
      void this.prune();
    }

    this.checkTimer = setTimeout(() => void this.autoCheck(), FIRST_CHECK_MS);
    this.emitState();
  }

  stop(): void {
    clearTimeout(this.trialTimer);
    clearTimeout(this.checkTimer);
  }

  /**
   * Uma tela conectou. Só confirma a versão nova se for a tela DELA: a tela antiga, que ainda
   * estava aberta, reconecta antes de recarregar e não prova nada.
   */
  launcherConnected(launcherVersion: string | undefined): void {
    if (!this.inTrial) return;
    if (launcherVersion !== this.version) {
      this.log.info(`[atualização] tela da versão ${launcherVersion ?? '?'} conectou; esperando a tela da ${this.version}`);
      return;
    }
    void this.commit();
  }

  private async commit(): Promise<void> {
    this.inTrial = false;
    clearTimeout(this.trialTimer);
    const last = await readJson<{ from: string; to: string }>(this.file('last-update'));
    await Promise.all(['pending', 'attempts', 'last-update'].map((f) => fs.rm(this.file(f as 'pending'), { force: true })));
    if (last) this.state.justUpdated = last;
    this.log.info(`[atualização] versão ${this.version} confirmada`);
    this.emitState();
    void this.prune();
  }

  private async rollback(reason: string): Promise<void> {
    const previous = (await fs.readFile(this.file('pending'), 'utf8').catch(() => '')).trim();
    if (!previous || !(await exists(path.join(this.releasesDir, previous)))) {
      this.log.warn(`[atualização] ${reason}, mas não há versão anterior para voltar`);
      return;
    }
    this.log.warn(`[atualização] ${reason}: voltando para ${previous}`);
    await pointCurrent(this.options.installRoot, previous);
    await writeJson(this.file('failed'), { from: this.version, to: previous });
    await Promise.all(['pending', 'attempts', 'last-update'].map((f) => fs.rm(this.file(f as 'pending'), { force: true })));
    this.emit('restart', previous);
  }

  private async unsupportedReason(): Promise<string | null> {
    if (this.options.mode === 'off') return 'A atualização pelo Wi-Fi está desligada na configuração do console.';
    if (this.options.mode === 'auto' && process.platform !== 'linux') {
      return 'A atualização pelo Wi-Fi é do console (Raspberry Pi). No computador, atualize pelo git.';
    }
    try {
      const running = await fs.realpath(this.options.appRoot);
      const releases = await fs.realpath(this.releasesDir);
      const current = await fs.realpath(this.currentLink);
      if (path.dirname(running) !== releases || running !== current) throw new Error('fora do lugar');
      return null;
    } catch {
      return 'Este console foi instalado do jeito antigo. Rode o setup.sh de novo uma vez para ligar a atualização pelo Wi-Fi.';
    }
  }

  // ---------------------------------------------------------------- procurar

  private async autoCheck(): Promise<void> {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => void this.autoCheck(), CHECK_EVERY_MS);
    if (this.state.phase !== 'idle' || this.inTrial) return;
    try {
      await this.check(true);
    } catch {
      /* sem internet agora: tenta de novo amanhã (a tela mostra o erro só quando alguém pede) */
    }
  }

  /** Procura uma versão nova. `quiet`: a checagem automática não deixa erro na tela. */
  async check(quiet = false): Promise<UpdateState> {
    this.assertSupported();
    if (this.state.phase !== 'idle') throw new UpdateError('Já estou cuidando de uma atualização.', 409);
    this.state.phase = 'checking';
    if (!quiet) this.state.error = null;
    this.emitState();
    try {
      const manifest = await this.fetchManifest();
      this.state.lastCheckedAt = new Date().toISOString();
      if (compareVersions(manifest.version, this.version) > 0) {
        this.manifest = manifest;
        const { version, notes, size, publishedAt } = manifest;
        if (this.state.available?.version !== version) this.log.info(`[atualização] versão nova disponível: ${version}`);
        this.state.available = { version, notes, size, publishedAt };
      } else {
        this.manifest = null;
        this.state.available = null;
      }
    } catch (err) {
      if (!quiet) this.state.error = (err as Error).message;
      throw err;
    } finally {
      this.state.phase = 'idle';
      this.emitState();
    }
    return this.getState();
  }

  private async fetchManifest(): Promise<Manifest> {
    let raw: unknown;
    try {
      const res = await fetch(this.options.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
      if (res.status === 404) throw new UpdateError('Ainda não há nenhuma versão publicada.');
      if (!res.ok) throw new UpdateError(`O servidor de atualizações respondeu ${res.status}.`);
      raw = await res.json();
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      throw new UpdateError('Sem internet agora: não consegui procurar atualizações. Confira o Wi-Fi.');
    }
    const m = raw as Partial<Manifest> | null;
    const ok =
      m &&
      typeof m.version === 'string' &&
      /^\d+\.\d+\.\d+/.test(m.version) &&
      typeof m.url === 'string' &&
      /^https?:\/\//.test(m.url) &&
      typeof m.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(m.sha256) &&
      typeof m.size === 'number' &&
      m.size > 0 &&
      typeof m.signature === 'string';
    if (!ok) throw new UpdateError('A versão publicada está incompleta: não vou instalar.');
    // A assinatura cobre a versão e o sha256: o pacote baixado tem que bater com os dois.
    const valid = crypto.verify(null, Buffer.from(signedMessage(m.version!, m.sha256!)), RELEASE_PUBLIC_KEY, Buffer.from(m.signature!, 'base64'));
    if (!valid) throw new UpdateError('A versão publicada não tem uma assinatura válida do Playzin: não vou instalar.');
    return {
      version: m.version!,
      url: m.url!,
      sha256: m.sha256!,
      size: m.size!,
      signature: m.signature!,
      notes: typeof m.notes === 'string' ? m.notes.slice(0, 4000) : '',
      publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : '',
    };
  }

  // ---------------------------------------------------------------- baixar

  async download(): Promise<UpdateState> {
    this.assertSupported();
    const manifest = this.manifest;
    if (!manifest) throw new UpdateError('Não há versão nova para baixar. Procure de novo.', 409);
    if (this.state.phase !== 'idle') throw new UpdateError('Já estou cuidando de uma atualização.', 409);
    this.state.phase = 'downloading';
    this.state.progress = 0;
    this.state.error = null;
    this.emitState();
    // Baixa em segundo plano: o progresso vai pelo WebSocket.
    void this.downloadAndExtract(manifest).catch((err: Error) => {
      this.log.warn(`[atualização] ${err.message}`);
      this.state.error = err instanceof UpdateError ? err.message : `Não consegui baixar a atualização: ${err.message}`;
      this.state.phase = 'idle';
      this.emitState();
    });
    return this.getState();
  }

  private async downloadAndExtract(m: Manifest): Promise<void> {
    const incoming = path.join(this.releasesDir, '.incoming');
    await fs.mkdir(incoming, { recursive: true });
    const free = await freeBytes(this.releasesDir);
    if (free !== null && free < m.size * SPACE_FACTOR) {
      throw new UpdateError(`Falta espaço no cartão de memória: a atualização precisa de ${mb(m.size * SPACE_FACTOR)} livres.`);
    }
    const file = path.join(incoming, `playzin-${m.version}.tar.gz`);
    let res: Response;
    try {
      res = await fetch(m.url, { redirect: 'follow' });
    } catch {
      throw new UpdateError('A internet caiu: não consegui baixar a atualização.');
    }
    if (!res.ok || !res.body) throw new UpdateError(`O servidor de atualizações respondeu ${res.status} ao baixar.`);
    const total = Number(res.headers.get('content-length')) || m.size;
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        hash.update(chunk);
        received += chunk.length;
        if (received > m.size * 2) return done(new UpdateError('O pacote baixado é maior que o anunciado: não vou instalar.'));
        this.state.progress = Math.min(0.99, received / total);
        this.emitState(true);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(file));
    } catch (err) {
      await fs.rm(file, { force: true });
      if (err instanceof UpdateError) throw err;
      throw new UpdateError('A internet caiu no meio do download. Tente de novo.');
    }
    if (hash.digest('hex') !== m.sha256) {
      await fs.rm(file, { force: true });
      throw new UpdateError('O pacote baixado não confere com a assinatura (veio corrompido?). Tente de novo.');
    }

    // Extrai ao lado e só depois dá o nome final (uma pasta pela metade nunca vira uma versão).
    const target = path.join(this.releasesDir, m.version);
    const temp = `${target}.extracting`;
    await fs.rm(temp, { recursive: true, force: true });
    await fs.mkdir(temp, { recursive: true });
    try {
      // No Windows (só nos testes), o tar do Windows: o do Git lê "C:\..." como endereço de rede.
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      await run(tar, ['-xzf', file, '-C', temp]);
      const pkg = await readJson<{ version?: string }>(path.join(temp, 'package.json'));
      if (pkg?.version !== m.version || !(await exists(path.join(temp, 'packages/daemon/dist/main.js')))) {
        throw new UpdateError('O pacote baixado não é uma versão completa do Playzin: não vou instalar.');
      }
      // O serviço da TV roda o kiosk.sh direto da versão: garante que ele é executável.
      await fs.chmod(path.join(temp, 'scripts/pi/kiosk.sh'), 0o755).catch(() => undefined);
      const current = await fs.realpath(this.currentLink).catch(() => '');
      if (current && path.resolve(current) === path.resolve(target)) throw new UpdateError('Esta versão já está instalada.');
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { recursive: true, force: true });
      throw err;
    } finally {
      await fs.rm(file, { force: true });
    }
    this.state.progress = 1;
    this.state.phase = 'ready';
    this.log.info(`[atualização] versão ${m.version} baixada e conferida: esperando a confirmação na TV`);
    this.emitState();
  }

  // ---------------------------------------------------------------- instalar

  /** Depois da confirmação na TV: troca a versão e reinicia o daemon. */
  async install(): Promise<UpdateState> {
    this.assertSupported();
    const m = this.manifest;
    if (this.state.phase !== 'ready' || !m) throw new UpdateError('Baixe a atualização antes de instalar.', 409);
    const target = path.join(this.releasesDir, m.version);
    if (!(await exists(path.join(target, 'packages/daemon/dist/main.js')))) {
      this.state.phase = 'idle';
      this.emitState();
      throw new UpdateError('A versão baixada sumiu. Baixe de novo.', 409);
    }
    this.state.phase = 'installing';
    this.emitState();
    const previous = path.basename(await fs.realpath(this.currentLink));
    await fs.writeFile(this.file('pending'), `${previous}\n`);
    await fs.rm(this.file('attempts'), { force: true });
    await writeJson(this.file('last-update'), { from: this.version, to: m.version });
    await pointCurrent(this.options.installRoot, m.version);
    this.log.info(`[atualização] instalada a versão ${m.version} (antes: ${previous}): reiniciando`);
    this.emit('restart', m.version);
    return this.getState();
  }

  // ---------------------------------------------------------------- limpeza

  /** Guarda só a versão atual e a anterior. */
  private async prune(): Promise<void> {
    try {
      const current = path.basename(await fs.realpath(this.currentLink));
      const entries = await fs.readdir(this.releasesDir, { withFileTypes: true });
      const versions = await Promise.all(
        entries
          .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name) && !e.name.endsWith('.extracting') && e.name !== current)
          .map(async (e) => ({ name: e.name, mtime: (await fs.stat(path.join(this.releasesDir, e.name))).mtimeMs })),
      );
      versions.sort((a, b) => b.mtime - a.mtime);
      for (const old of versions.slice(1)) {
        await fs.rm(path.join(this.releasesDir, old.name), { recursive: true, force: true });
        this.log.info(`[atualização] versão antiga apagada: ${old.name}`);
      }
      await fs.rm(path.join(this.releasesDir, '.incoming'), { recursive: true, force: true });
    } catch (err) {
      this.log.warn(`[atualização] limpeza: ${(err as Error).message}`);
    }
  }

  private assertSupported(): void {
    if (!this.state.supported) throw new UpdateError(this.state.problem ?? 'A atualização não funciona aqui.', 501);
  }

  /** `throttled`: o progresso do download avisa no máximo ~4 vezes por segundo. */
  private emitState(throttled = false): void {
    const now = Date.now();
    if (throttled && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.emit('state', this.getState());
  }
}

// ---------------------------------------------------------------- ajudantes

/** Aponta o link current para releases/<nome>, de uma vez só (rename por cima do link antigo). */
export async function pointCurrent(installRoot: string, releaseName: string): Promise<void> {
  const link = path.join(installRoot, 'current');
  if (process.platform === 'win32') {
    // Só nos testes no PC: no Windows não dá para trocar um link por cima de outro.
    await fs.rm(link, { force: true, recursive: false }).catch(() => fs.rmdir(link).catch(() => undefined));
    await fs.symlink(path.join(installRoot, 'releases', releaseName), link, 'junction');
    return;
  }
  const temp = `${link}.new`;
  await fs.rm(temp, { force: true });
  await fs.symlink(path.join('releases', releaseName), temp);
  await fs.rename(temp, link);
}

/** -1, 0 ou 1. "0.4.0-beta" vem antes de "0.4.0". */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2);
    return { nums: core!.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
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
  return `${Math.ceil(bytes / 1_000_000)} MB`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(data)}\n`);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, _out, stderr) => {
      if (err) reject(new UpdateError(`Não consegui extrair a atualização: ${String(stderr || err.message).trim().slice(0, 200)}`));
      else resolve();
    });
  });
}
