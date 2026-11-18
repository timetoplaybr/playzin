import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@playzin/shared';

/** Funciona tanto rodando de src/ (tsx) quanto de dist/ (node): ambos ficam em packages/daemon/<pasta>. */
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

export type SourceMode = 'auto' | 'dir' | 'udisks';

export interface DaemonConfig {
  host: string;
  port: number;
  launcherDir: string;
  sourceMode: SourceMode;
  /** Pastas observadas: cada subpasta com um playzin.json conta como cartucho inserido. */
  slotDirs: string[];
  /** Pastas que são, elas mesmas, um possível cartucho (no Windows: a raiz de cada unidade, E:\\ etc.). */
  driveRoots: string[];
  pollIntervalMs: number;
  /** Onde ficam os saves dos jogos (um JSON por jogo). */
  savesDir: string;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items.map((p) => path.resolve(p)) : undefined;
}

/**
 * No Windows, pendrives aparecem como unidades (E:\\, F:\\...): o cartucho é a raiz da unidade.
 * A unidade do sistema (C:) e A:/B: (disquete, lentas para consultar) ficam de fora.
 */
function defaultDriveRoots(): string[] {
  if (os.platform() !== 'win32') return [];
  const system = (process.env.SystemDrive ?? 'C:').toUpperCase()[0];
  return 'DEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .filter((letter) => letter !== system)
    .map((letter) => `${letter}:\\`);
}

function defaultSlotDirs(): string[] {
  const dirs = [path.join(REPO_ROOT, 'dev-slot')];
  // No Mac, pendrives aparecem em /Volumes: dá para testar com um cartucho de verdade.
  if (os.platform() === 'darwin') dirs.push('/Volumes');
  return dirs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const mode = (env.PLAYZIN_SOURCE ?? 'auto') as SourceMode;
  if (!['auto', 'dir', 'udisks'].includes(mode)) {
    throw new Error(`PLAYZIN_SOURCE inválido: "${mode}" (use auto, dir ou udisks)`);
  }
  const port = Number(env.PLAYZIN_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PLAYZIN_PORT inválida: "${env.PLAYZIN_PORT}"`);
  }
  return {
    // Só localhost: o console não deve expor jogos nem a API para a rede.
    host: env.PLAYZIN_HOST ?? '127.0.0.1',
    port,
    launcherDir: path.resolve(env.PLAYZIN_LAUNCHER_DIR ?? path.join(REPO_ROOT, 'packages/launcher/dist')),
    sourceMode: mode,
    slotDirs: parseList(env.PLAYZIN_SLOT_DIRS) ?? defaultSlotDirs(),
    driveRoots: parseList(env.PLAYZIN_DRIVE_ROOTS) ?? defaultDriveRoots(),
    pollIntervalMs: Number(env.PLAYZIN_POLL_MS ?? 1000),
    // No Pi o systemd define /var/lib/playzin/saves; no computador fica dentro do projeto.
    savesDir: path.resolve(env.PLAYZIN_SAVES_DIR ?? path.join(REPO_ROOT, '.playzin-data', 'saves')),
  };
}
