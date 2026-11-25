import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT } from '@playzin/shared';

/** Funciona tanto rodando de src/ (tsx) quanto de dist/ (node): ambos ficam em packages/daemon/<pasta>. */
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

export type SourceMode = 'auto' | 'dir' | 'udisks';
export type BluetoothMode = 'auto' | 'bluez' | 'mock' | 'none';
export type WifiMode = 'auto' | 'networkmanager' | 'mock' | 'none';
export type PowerMode = 'auto' | 'logind' | 'mock' | 'none';

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
  /** Lista de perfis do console (padrão: profiles.json ao lado da pasta de saves). */
  profilesFile: string;
  /** Álbum de capturas de tela (padrão: screenshots/ ao lado da pasta de saves). */
  screenshotsDir: string;
  /** auto = BlueZ se houver; mock = Bluetooth simulado (para testar a tela no PC). */
  bluetooth: BluetoothMode;
  /** Pareamento automático ao ligar sem controle conhecido (undefined = padrão do backend). */
  autoPair: boolean | undefined;
  /** auto = NetworkManager se houver; mock = Wi-Fi simulado (para testar a tela no PC). */
  wifi: WifiMode;
  /**
   * Desligar/reiniciar pela tela. auto = logind só quando o daemon roda como serviço do systemd
   * (o console de verdade); fora disso, simulado, para não desligar o computador de quem desenvolve.
   */
  power: PowerMode;
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

/** Lê --nome=valor da linha de comando (ex.: --bluetooth=mock). */
function arg(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): DaemonConfig {
  const mode = (env.PLAYZIN_SOURCE ?? 'auto') as SourceMode;
  if (!['auto', 'dir', 'udisks'].includes(mode)) {
    throw new Error(`PLAYZIN_SOURCE inválido: "${mode}" (use auto, dir ou udisks)`);
  }
  const port = Number(env.PLAYZIN_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PLAYZIN_PORT inválida: "${env.PLAYZIN_PORT}"`);
  }
  // No Pi o systemd define /var/lib/playzin/saves; no computador fica dentro do projeto.
  const savesDir = path.resolve(env.PLAYZIN_SAVES_DIR ?? path.join(REPO_ROOT, '.playzin-data', 'saves'));
  return {
    // Só localhost: o console não deve expor jogos nem a API para a rede.
    host: env.PLAYZIN_HOST ?? '127.0.0.1',
    port,
    launcherDir: path.resolve(env.PLAYZIN_LAUNCHER_DIR ?? path.join(REPO_ROOT, 'packages/launcher/dist')),
    sourceMode: mode,
    slotDirs: parseList(env.PLAYZIN_SLOT_DIRS) ?? defaultSlotDirs(),
    driveRoots: parseList(env.PLAYZIN_DRIVE_ROOTS) ?? defaultDriveRoots(),
    pollIntervalMs: Number(env.PLAYZIN_POLL_MS ?? 1000),
    savesDir,
    profilesFile: path.resolve(env.PLAYZIN_PROFILES_FILE ?? path.join(path.dirname(savesDir), 'profiles.json')),
    screenshotsDir: path.resolve(env.PLAYZIN_SCREENSHOTS_DIR ?? path.join(path.dirname(savesDir), 'screenshots')),
    bluetooth: parseBluetooth(arg(argv, 'bluetooth') ?? env.PLAYZIN_BLUETOOTH ?? 'auto'),
    autoPair: parseBool(arg(argv, 'autopair') ?? env.PLAYZIN_BT_AUTOPAIR),
    wifi: parseWifi(arg(argv, 'wifi') ?? env.PLAYZIN_WIFI ?? 'auto'),
    power: parsePower(arg(argv, 'power') ?? env.PLAYZIN_POWER ?? 'auto'),
  };
}

function parseBluetooth(value: string): BluetoothMode {
  if (!['auto', 'bluez', 'mock', 'none'].includes(value)) {
    throw new Error(`Bluetooth inválido: "${value}" (use auto, bluez, mock ou none)`);
  }
  return value as BluetoothMode;
}

function parseWifi(value: string): WifiMode {
  if (!['auto', 'networkmanager', 'mock', 'none'].includes(value)) {
    throw new Error(`Wi-Fi inválido: "${value}" (use auto, networkmanager, mock ou none)`);
  }
  return value as WifiMode;
}

function parsePower(value: string): PowerMode {
  if (!['auto', 'logind', 'mock', 'none'].includes(value)) {
    throw new Error(`Energia inválida: "${value}" (use auto, logind, mock ou none)`);
  }
  return value as PowerMode;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return !['0', 'false', 'no', 'nao', 'não'].includes(value.toLowerCase());
}
