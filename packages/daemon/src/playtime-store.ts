import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLAYTIME_MAX_CHUNK_SECONDS,
  PROFILE_ID_PATTERN,
  type PlaytimeEntry,
  type PlaytimeSummary,
} from '@playzin/shared';

const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SESSION_PATTERN = /^[A-Za-z0-9-]{6,64}$/;
const FILE_NAME = '_playtime.json';

interface PlaytimeFile {
  format: 1;
  games: Record<string, PlaytimeEntry & { lastSession?: string }>;
}

/**
 * Tempo de jogo por perfil: um _playtime.json dentro da pasta de saves de cada perfil
 * (saves/<perfil>/_playtime.json). Excluir o perfil apaga a pasta e, junto, o tempo dele.
 *
 * Quem mede é o launcher: ele avisa a cada 30 s quanto tempo de jogo ativo passou (sem contar
 * a janela escondida nem o jogo parado sem ninguém mexer), então um desligamento na tomada
 * perde no máximo esses 30 s.
 */
export class PlaytimeStore {
  private cache = new Map<string, PlaytimeFile>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly savesDir: string) {}

  /** Soma tempo jogado. `session` identifica uma partida: uma nova conta como mais uma sessão. */
  add(profile: string, game: string, input: { name: string; seconds: number; session: string }): Promise<PlaytimeEntry> {
    if (!PROFILE_ID_PATTERN.test(profile)) throw new Error('perfil inválido');
    if (!GAME_ID_PATTERN.test(game)) throw new Error('jogo inválido');
    if (!SESSION_PATTERN.test(input.session)) throw new Error('sessão inválida');
    const seconds = Math.max(0, Math.min(PLAYTIME_MAX_CHUNK_SECONDS, Math.round(input.seconds)));
    const name = input.name.slice(0, 80) || game;
    return this.serialize(profile, async () => {
      const data = await this.load(profile);
      const now = new Date().toISOString();
      const entry = (data.games[game] ??= {
        id: game,
        name,
        seconds: 0,
        sessions: 0,
        firstPlayedAt: now,
        lastPlayedAt: now,
      });
      entry.name = name;
      entry.seconds += seconds;
      entry.lastPlayedAt = now;
      if (entry.lastSession !== input.session) {
        entry.sessions++;
        entry.lastSession = input.session;
      }
      await this.persist(profile, data);
      return publicEntry(entry);
    });
  }

  async summary(profile: string): Promise<PlaytimeSummary> {
    if (!PROFILE_ID_PATTERN.test(profile)) throw new Error('perfil inválido');
    const data = await this.load(profile);
    const games = Object.values(data.games)
      .map(publicEntry)
      .filter((g) => g.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds);
    return { totalSeconds: games.reduce((sum, g) => sum + g.seconds, 0), games };
  }

  /** Total jogado por perfil (para a tela "Quem vai jogar?"). */
  async totals(profiles: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of profiles) out[id] = (await this.summary(id).catch(() => null))?.totalSeconds ?? 0;
    return out;
  }

  /** O perfil foi excluído (a pasta já sumiu junto com os saves). */
  forget(profile: string): void {
    this.cache.delete(profile);
  }

  private fileFor(profile: string): string {
    return path.join(this.savesDir, profile, FILE_NAME);
  }

  private async load(profile: string): Promise<PlaytimeFile> {
    const cached = this.cache.get(profile);
    if (cached) return cached;
    let data: PlaytimeFile = { format: 1, games: {} };
    for (const candidate of [this.fileFor(profile), `${this.fileFor(profile)}.bak`]) {
      try {
        const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as Partial<PlaytimeFile>;
        if (parsed && typeof parsed.games === 'object' && parsed.games) {
          data = { format: 1, games: sanitize(parsed.games) };
          break;
        }
      } catch {
        /* ainda não existe ou corrompido: tenta o backup */
      }
    }
    this.cache.set(profile, data);
    return data;
  }

  private async persist(profile: string, data: PlaytimeFile): Promise<void> {
    const file = this.fileFor(profile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch {
      /* primeira gravação */
    }
    await fs.rename(tmp, file);
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queues.set(key, next);
    return next;
  }
}

function publicEntry(e: PlaytimeEntry & { lastSession?: string }): PlaytimeEntry {
  const { lastSession: _, ...rest } = e;
  return rest;
}

function sanitize(games: Record<string, unknown>): PlaytimeFile['games'] {
  const out: PlaytimeFile['games'] = {};
  for (const [id, raw] of Object.entries(games)) {
    const g = raw as PlaytimeEntry & { lastSession?: string };
    if (!GAME_ID_PATTERN.test(id) || typeof g?.seconds !== 'number') continue;
    out[id] = {
      id,
      name: typeof g.name === 'string' ? g.name : id,
      seconds: Math.max(0, Math.floor(g.seconds)),
      sessions: Math.max(0, Math.floor(g.sessions ?? 0)),
      firstPlayedAt: String(g.firstPlayedAt ?? ''),
      lastPlayedAt: String(g.lastPlayedAt ?? ''),
      lastSession: typeof g.lastSession === 'string' ? g.lastSession : undefined,
    };
  }
  return out;
}
