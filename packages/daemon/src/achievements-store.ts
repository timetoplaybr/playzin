import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PROFILE_ID_PATTERN,
  RECENT_ACHIEVEMENTS,
  type AchievementDef,
  type AchievementStatus,
  type AchievementsSummary,
  type AchievementUnlock,
  type CartridgeManifest,
  type GameAchievements,
} from '@playzin/shared';

const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE_NAME = '_achievements.json';

/** Conquistas que o console já viu, por jogo (para mostrar "2 de 4" sem o cartucho). */
interface CatalogFile {
  format: 1;
  games: Record<string, { name: string; achievements: AchievementDef[] }>;
}

/** O que cada perfil desbloqueou: jogo → conquista → quando. */
interface ProfileFile {
  format: 1;
  games: Record<string, Record<string, string>>;
}

export class AchievementError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Conquistas:
 * - catálogo do console em saves/_achievements.json (as conquistas de cada jogo que já passou
 *   pelo console, atualizado sempre que um cartucho com conquistas entra);
 * - desbloqueios de cada perfil em saves/<perfil>/_achievements.json (excluir o perfil apaga a
 *   pasta e, junto, as conquistas dele).
 * Gravação atômica com a versão anterior em .bak, como os saves e o tempo de jogo.
 */
export class AchievementStore {
  private catalog: CatalogFile | null = null;
  private profiles = new Map<string, ProfileFile>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly savesDir: string) {}

  /** Um cartucho entrou: guarda (ou atualiza) as conquistas dele no catálogo. */
  remember(manifest: CartridgeManifest): Promise<void> {
    const achievements = manifest.achievements ?? [];
    return this.serialize('_catalog', async () => {
      const catalog = await this.loadCatalog();
      const known = catalog.games[manifest.id];
      if (achievements.length === 0 && !known) return;
      if (known && known.name === manifest.name && JSON.stringify(known.achievements) === JSON.stringify(achievements)) return;
      catalog.games[manifest.id] = { name: manifest.name, achievements };
      await writeAtomic(path.join(this.savesDir, FILE_NAME), catalog);
    });
  }

  /**
   * Desbloqueia uma conquista do jogo inserido agora. Quem garante que o jogo é o do cartucho
   * é o servidor (só aceita o id do cartucho ativo); aqui confere se a conquista existe nele.
   */
  unlock(profile: string, manifest: CartridgeManifest, id: string): Promise<AchievementUnlock> {
    if (!PROFILE_ID_PATTERN.test(profile)) throw new AchievementError('perfil inválido');
    const def = manifest.achievements?.find((a) => a.id === id);
    if (!def) throw new AchievementError(`"${manifest.name}" não tem a conquista "${id}" no playzin.json`, 404);
    return this.serialize(profile, async () => {
      await this.remember(manifest);
      const data = await this.loadProfile(profile);
      const game = (data.games[manifest.id] ??= {});
      const isNew = !game[id];
      if (isNew) {
        game[id] = new Date().toISOString();
        await writeAtomic(this.profileFile(profile), data);
      }
      const defs = manifest.achievements ?? [];
      return {
        achievement: { ...def, unlockedAt: game[id]! },
        isNew,
        unlocked: defs.filter((a) => game[a.id]).length,
        total: defs.length,
      };
    });
  }

  /** Conquistas de um jogo para um perfil. Secretas bloqueadas vêm sem nome nem descrição. */
  async forGame(profile: string, gameId: string): Promise<GameAchievements> {
    if (!PROFILE_ID_PATTERN.test(profile)) throw new AchievementError('perfil inválido');
    if (!GAME_ID_PATTERN.test(gameId)) throw new AchievementError('jogo inválido');
    const entry = (await this.loadCatalog()).games[gameId];
    const unlocked = (await this.loadProfile(profile)).games[gameId] ?? {};
    const defs = entry?.achievements ?? [];
    const list: AchievementStatus[] = defs.map((a) => {
      const at = unlocked[a.id] ?? null;
      if (a.hidden && !at) return { id: a.id, name: 'Conquista secreta', description: 'Continue jogando para descobrir.', hidden: true, unlockedAt: null };
      return { ...a, unlockedAt: at };
    });
    const done = list.filter((a) => a.unlockedAt).sort((a, b) => b.unlockedAt!.localeCompare(a.unlockedAt!));
    const locked = list.filter((a) => !a.unlockedAt);
    return { id: gameId, name: entry?.name ?? gameId, total: defs.length, unlocked: done.length, achievements: [...done, ...locked] };
  }

  /** Quantas conquistas o perfil tem em cada jogo com conquistas. */
  async summary(profile: string): Promise<AchievementsSummary> {
    if (!PROFILE_ID_PATTERN.test(profile)) throw new AchievementError('perfil inválido');
    const catalog = await this.loadCatalog();
    const data = await this.loadProfile(profile);
    const recent: AchievementsSummary['recent'] = [];
    const games = Object.entries(catalog.games)
      .filter(([, g]) => g.achievements.length > 0)
      .map(([id, g]) => {
        const unlocked = data.games[id] ?? {};
        for (const a of g.achievements) {
          const at = unlocked[a.id];
          if (at) recent.push({ gameId: id, gameName: g.name, id: a.id, name: a.name, description: a.description, unlockedAt: at });
        }
        const dates = g.achievements.map((a) => unlocked[a.id]).filter((d): d is string => Boolean(d));
        return {
          id,
          name: g.name,
          total: g.achievements.length,
          unlocked: dates.length,
          lastUnlockedAt: dates.sort().at(-1) ?? null,
        };
      });
    recent.sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt));
    return { games, recent: recent.slice(0, RECENT_ACHIEVEMENTS) };
  }

  /** Os arquivos foram trocados por baixo (restauração de um backup): esquece o que estava em memória. */
  reload(): void {
    this.catalog = null;
    this.profiles.clear();
  }

  /** O perfil foi excluído (a pasta já sumiu junto com os saves). */
  forget(profile: string): void {
    this.profiles.delete(profile);
  }

  private profileFile(profile: string): string {
    return path.join(this.savesDir, profile, FILE_NAME);
  }

  private async loadCatalog(): Promise<CatalogFile> {
    if (this.catalog) return this.catalog;
    const raw = await readWithBackup(path.join(this.savesDir, FILE_NAME));
    const games: CatalogFile['games'] = {};
    for (const [id, g] of Object.entries((raw?.games ?? {}) as Record<string, unknown>)) {
      const entry = g as { name?: unknown; achievements?: unknown };
      if (!GAME_ID_PATTERN.test(id) || !Array.isArray(entry?.achievements)) continue;
      games[id] = {
        name: typeof entry.name === 'string' ? entry.name : id,
        achievements: (entry.achievements as AchievementDef[]).filter((a) => typeof a?.id === 'string' && typeof a?.name === 'string'),
      };
    }
    this.catalog = { format: 1, games };
    return this.catalog;
  }

  private async loadProfile(profile: string): Promise<ProfileFile> {
    const cached = this.profiles.get(profile);
    if (cached) return cached;
    const raw = await readWithBackup(this.profileFile(profile));
    const games: ProfileFile['games'] = {};
    for (const [id, unlocked] of Object.entries((raw?.games ?? {}) as Record<string, unknown>)) {
      if (!GAME_ID_PATTERN.test(id) || typeof unlocked !== 'object' || unlocked === null) continue;
      games[id] = Object.fromEntries(Object.entries(unlocked).filter(([, at]) => typeof at === 'string')) as Record<string, string>;
    }
    const data: ProfileFile = { format: 1, games };
    this.profiles.set(profile, data);
    return data;
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queues.set(key, next);
    return next;
  }
}

async function readWithBackup(file: string): Promise<{ games?: unknown } | null> {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as { games?: unknown };
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* ainda não existe ou corrompido: tenta o backup */
    }
  }
  return null;
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
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
