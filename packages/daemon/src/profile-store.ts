import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  cleanProfileName,
  MAX_PROFILES,
  PROFILE_COLORS,
  PROFILE_ICONS,
  PROFILE_ID_PATTERN,
  type Profile,
  type ProfileColor,
  type ProfileIcon,
} from '@playzin/shared';
import type { SaveStore } from './save-store.js';

interface ProfilesFile {
  format: 1;
  /** Primeiro perfil criado no console: só ele herda os dados antigos do navegador. */
  legacyOwner: string | null;
  profiles: Profile[];
}

/** Erro de validação: vira 400 (dados inválidos) ou 409 (conflito, ex.: limite de perfis). */
export class ProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface ProfileInput {
  name?: unknown;
  icon?: unknown;
  color?: unknown;
}

/**
 * Perfis do console (até 4), guardados em profiles.json ao lado da pasta de saves.
 * Configurações como Wi-Fi e controles não ficam aqui: são do console, valem para todos.
 *
 * Eventos: 'change' (lista atual) sempre que um perfil é criado, editado ou excluído.
 */
export class ProfileStore extends EventEmitter<{ change: [Profile[]] }> {
  private data: ProfilesFile = { format: 1, legacyOwner: null, profiles: [] };
  /** profiles.json já existia? Se não, o primeiro perfil herda os saves de antes dos perfis. */
  private existed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly saves: SaveStore,
  ) {
    super();
  }

  async init(): Promise<void> {
    for (const candidate of [this.file, `${this.file}.bak`]) {
      try {
        const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as Partial<ProfilesFile>;
        if (!Array.isArray(parsed.profiles)) continue;
        this.data = {
          format: 1,
          legacyOwner: typeof parsed.legacyOwner === 'string' ? parsed.legacyOwner : null,
          profiles: parsed.profiles.filter(isProfile).slice(0, MAX_PROFILES),
        };
        this.existed = true;
        return;
      } catch {
        /* não existe ou corrompido: tenta o backup */
      }
    }
  }

  /** Os arquivos foram trocados por baixo (restauração de um backup): lê tudo de novo e avisa a TV. */
  async reload(): Promise<void> {
    this.data = { format: 1, legacyOwner: null, profiles: [] };
    this.existed = false;
    await this.init();
    this.emit('change', this.list());
  }

  list(): Profile[] {
    return this.data.profiles.map((p) => ({ ...p }));
  }

  get(id: unknown): Profile | undefined {
    if (typeof id !== 'string') return undefined;
    return this.data.profiles.find((p) => p.id === id);
  }

  /** Este perfil herda os dados que estavam no navegador antes dos saves no console? */
  ownsLegacy(id: string): boolean {
    return this.data.legacyOwner === id;
  }

  create(input: ProfileInput): Promise<Profile> {
    return this.serialize(async () => {
      if (this.data.profiles.length >= MAX_PROFILES) {
        throw new ProfileError(`o console aceita até ${MAX_PROFILES} perfis`, 409);
      }
      const name = this.validName(input.name);
      const profile: Profile = {
        id: this.newId(),
        name,
        icon: pick(input.icon, PROFILE_ICONS, 'ícone') ?? this.unusedIcon(),
        color: pick(input.color, PROFILE_COLORS, 'cor') ?? this.unusedColor(),
        createdAt: new Date().toISOString(),
      };
      const first = !this.existed && this.data.profiles.length === 0;
      if (first) {
        // Atualização de uma versão sem perfis: os saves que já existiam passam a ser deste perfil.
        await this.saves.adoptUnowned(profile.id);
        this.data.legacyOwner = profile.id;
      }
      this.data.profiles.push(profile);
      await this.persist();
      return { ...profile };
    });
  }

  update(id: string, input: ProfileInput): Promise<Profile> {
    return this.serialize(async () => {
      const profile = this.get(id);
      if (!profile) throw new ProfileError('perfil não encontrado', 404);
      if (input.name !== undefined) profile.name = this.validName(input.name, id);
      const icon = pick(input.icon, PROFILE_ICONS, 'ícone');
      if (icon) profile.icon = icon;
      const color = pick(input.color, PROFILE_COLORS, 'cor');
      if (color) profile.color = color;
      await this.persist();
      return { ...profile };
    });
  }

  /** Exclui o perfil e todos os saves dele. */
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.get(id)) throw new ProfileError('perfil não encontrado', 404);
      this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
      await this.persist();
      await this.saves.deleteProfile(id);
    });
  }

  private validName(raw: unknown, ignoreId?: string): string {
    const name = cleanProfileName(raw);
    if (!name) throw new ProfileError('o nome precisa ter de 1 a 16 letras', 400);
    const taken = this.data.profiles.some(
      (p) => p.id !== ignoreId && p.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'),
    );
    if (taken) throw new ProfileError(`já existe um perfil chamado ${name}`, 409);
    return name;
  }

  private newId(): string {
    let id: string;
    do id = `p${randomBytes(4).toString('hex')}`;
    while (this.get(id));
    return id;
  }

  private unusedIcon(): ProfileIcon {
    return PROFILE_ICONS.find((i) => !this.data.profiles.some((p) => p.icon === i)) ?? PROFILE_ICONS[0];
  }

  private unusedColor(): ProfileColor {
    return PROFILE_COLORS.find((c) => !this.data.profiles.some((p) => p.color === c)) ?? PROFILE_COLORS[0];
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(this.data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.copyFile(this.file, `${this.file}.bak`);
    } catch {
      /* primeira gravação */
    }
    await fs.rename(tmp, this.file);
    this.existed = true;
    this.emit('change', this.list());
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(task);
    this.queue = next;
    return next;
  }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ProfileError(`${label} inválido`, 400);
  return value as T;
}

function isProfile(value: unknown): value is Profile {
  const p = value as Profile;
  return (
    typeof p === 'object' &&
    p !== null &&
    PROFILE_ID_PATTERN.test(p.id) &&
    typeof p.name === 'string' &&
    PROFILE_ICONS.includes(p.icon) &&
    PROFILE_COLORS.includes(p.color)
  );
}
