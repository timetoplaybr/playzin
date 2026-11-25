/**
 * Tipos e contratos compartilhados entre o daemon, o launcher e o SDK.
 * Mudou algo aqui? Os três pacotes enxergam a mudança em tempo de compilação.
 */

export const DEFAULT_PORT = 7777;
export const MANIFEST_FILE = 'playzin.json';
export const WS_PATH = '/ws';
export const CARTRIDGE_URL_PREFIX = '/cart';

/** Conteúdo do arquivo playzin.json que fica na raiz de cada cartucho. */
export interface CartridgeManifest {
  /** Identificador único, em minúsculas (ex.: "chapelao"). Usado para separar saves. */
  id: string;
  /** Nome exibido no launcher. */
  name: string;
  /** Versão do jogo (ex.: "1.0.0"). */
  version: string;
  /** Arquivo HTML de entrada, relativo à raiz do cartucho. Padrão: "index.html". */
  entry: string;
  description?: string;
  /** Imagem de capa (relativa à raiz do cartucho), exibida no launcher. */
  cover?: string;
  /** Quantidade de jogadores suportada (ex.: 1 ou [1, 2]). */
  players?: number | [number, number];
  author?: string;
}

/** Cartucho pronto para jogar, como o daemon anuncia ao launcher. */
export interface CartridgeInfo {
  manifest: CartridgeManifest;
  /** Identificador desta inserção específica (muda a cada vez que o cartucho é inserido). */
  slotId: string;
  /** URL do HTML de entrada, já servida pelo daemon. */
  entryUrl: string;
  /** URL da capa, se houver. */
  coverUrl?: string;
  insertedAt: string;
}

/** Tipo de dispositivo Bluetooth, deduzido do ícone/classe que o próprio aparelho anuncia. */
export type BluetoothKind = 'gamepad' | 'keyboard' | 'mouse' | 'other';

export interface BluetoothDevice {
  /** Endereço MAC (ex.: "AA:BB:CC:DD:EE:FF"). */
  address: string;
  name: string;
  kind: BluetoothKind;
  paired: boolean;
  connected: boolean;
  /** O console está pareando este aparelho agora. */
  pairing: boolean;
  /** Carga da bateria, 0–100 (null = o aparelho não informa, ou está desligado). */
  battery: number | null;
  /** Carregando agora (cabo USB), quando o aparelho informa. */
  charging: boolean;
}

/** Bateria nesse nível ou abaixo: o console avisa. */
export const LOW_BATTERY_PERCENT = 15;

export interface BluetoothState {
  /** Há Bluetooth neste console? (No PC de desenvolvimento normalmente não.) */
  available: boolean;
  /** "bluez" no Raspberry Pi, "mock" no Bluetooth simulado, "none" sem Bluetooth. */
  backend: 'bluez' | 'mock' | 'none';
  /** Procurando aparelhos agora. */
  scanning: boolean;
  /** Pareamento automático: o console liga sem controle conhecido e pareia o primeiro que achar. */
  autoPair: boolean;
  /** Só aparelhos de entrada (controles, teclados, mouses) e os já pareados. */
  devices: BluetoothDevice[];
}

export interface WifiNetwork {
  ssid: string;
  /** Força do sinal, 0–100. */
  signal: number;
  /** Pede senha? */
  secured: boolean;
  /** O console já tem esta rede salva (conecta sem pedir senha). */
  known: boolean;
  connected: boolean;
}

export interface WifiState {
  /** Há Wi-Fi controlável neste console? (No PC de desenvolvimento normalmente não.) */
  available: boolean;
  backend: 'networkmanager' | 'mock' | 'none';
  scanning: boolean;
  /** Rede à qual o console está tentando se conectar agora. */
  connecting: string | null;
  current: { ssid: string; signal: number; ip: string | null } | null;
  /** Redes por perto (sem repetir nome), a conectada primeiro. */
  networks: WifiNetwork[];
}

// ---- Energia: desligar e reiniciar pela tela ----

export type PowerAction = 'poweroff' | 'reboot';

export interface PowerState {
  /** "logind" no Raspberry Pi (desliga de verdade), "mock" no PC (só simula), "none" sem suporte. */
  backend: 'logind' | 'mock' | 'none';
}

// ---- Perfis: até 4 pessoas por console, cada uma com seus saves ----

export const MAX_PROFILES = 4;
export const PROFILE_NAME_MAX = 16;

/** Ícones de perfil (desenhos próprios do Playzin, em ui/icons.ts do launcher). */
export const PROFILE_ICONS = [
  'star', 'heart', 'bolt', 'moon', 'sun', 'leaf', 'music', 'rocket', 'crown', 'cat', 'paw', 'flower',
] as const;
export type ProfileIcon = (typeof PROFILE_ICONS)[number];

/** Cores de perfil (o launcher traduz cada nome para um gradiente). */
export const PROFILE_COLORS = ['coral', 'ocean', 'forest', 'grape', 'sunny', 'mint', 'rose', 'slate'] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];

export interface Profile {
  /** Identificador interno (ex.: "p1a2b3c4d"): nome da pasta dos saves deste perfil. */
  id: string;
  name: string;
  icon: ProfileIcon;
  color: ProfileColor;
  createdAt: string;
}

export const PROFILE_ID_PATTERN = /^p[0-9a-f]{8}$/;

/** Nome de perfil limpo (espaços repetidos viram um), ou null se for inválido. */
export function cleanProfileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || [...name].length > PROFILE_NAME_MAX) return null;
  return name;
}

/** Mensagens que o daemon envia ao launcher via WebSocket. */
export type ServerMessage =
  | { type: 'state'; cartridge: CartridgeInfo | null }
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'bluetooth'; state: BluetoothState }
  | { type: 'bluetooth-paired'; device: BluetoothDevice; auto: boolean }
  | { type: 'bluetooth-error'; message: string; address?: string }
  | { type: 'wifi'; state: WifiState }
  | { type: 'wifi-connected'; ssid: string }
  | { type: 'wifi-error'; message: string; ssid?: string; wrongPassword?: boolean }
  | { type: 'power'; state: PowerState }
  /** O console vai desligar/reiniciar agora (o launcher mostra a tela de "Desligando…"). */
  | { type: 'power-action'; action: PowerAction; simulated: boolean }
  | { type: 'power-error'; message: string }
  | { type: 'cartridge-inserted'; cartridge: CartridgeInfo }
  | { type: 'cartridge-removed'; slotId: string }
  | { type: 'cartridge-error'; message: string; source: string };

/** Mensagens que o launcher envia ao daemon. */
export type ClientMessage = { type: 'hello'; client: 'launcher' } | { type: 'ping' };

/** Mensagens trocadas via postMessage entre o jogo (dentro do iframe) e o launcher. */
export type GameToLauncherMessage =
  | { source: 'playzin-sdk'; type: 'ready' }
  | { source: 'playzin-sdk'; type: 'exit' };

export type LauncherToGameMessage = { source: 'playzin-launcher'; type: 'pause' | 'resume' };

/** Um jogo com progresso salvo no console (GET /api/saves). */
export interface SaveSummary {
  id: string;
  name: string;
  gameVersion: string;
  updatedAt: string;
  bytes: number;
  keys: number;
}

/** Tempo de jogo de um perfil em um jogo (GET /api/playtime). */
export interface PlaytimeEntry {
  id: string;
  name: string;
  seconds: number;
  /** Quantas vezes o jogo foi aberto por este perfil. */
  sessions: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
}

export interface PlaytimeSummary {
  totalSeconds: number;
  /** Mais jogados primeiro. */
  games: PlaytimeEntry[];
}

/** Quanto cada perfil jogou de um jogo (GET /api/playtime/game/:id). */
export interface GamePlaytime {
  id: string;
  name: string;
  totalSeconds: number;
  /** Só perfis que já jogaram, mais tempo primeiro. */
  players: { profile: string; seconds: number; sessions: number; lastPlayedAt: string }[];
}

/** Maior pedaço de tempo aceito num único aviso do launcher (o launcher avisa a cada 30 s). */
export const PLAYTIME_MAX_CHUNK_SECONDS = 120;

export interface ManifestValidation {
  ok: boolean;
  manifest?: CartridgeManifest;
  errors: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Caminho relativo seguro: sem "..", sem caminho absoluto. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((part) => part === '..');
}

/** Valida o conteúdo (já parseado) de um playzin.json. */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['playzin.json precisa ser um objeto JSON'] };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== 'string' || !ID_PATTERN.test(r.id)) {
    errors.push('"id" é obrigatório: letras minúsculas, números, ".", "-" ou "_" (até 64 caracteres)');
  }
  if (typeof r.name !== 'string' || r.name.trim().length === 0 || r.name.length > 80) {
    errors.push('"name" é obrigatório (até 80 caracteres)');
  }
  if (typeof r.version !== 'string' || r.version.trim().length === 0) {
    errors.push('"version" é obrigatório (ex.: "1.0.0")');
  }
  const entry = r.entry === undefined ? 'index.html' : r.entry;
  if (typeof entry !== 'string' || !isSafeRelativePath(entry)) {
    errors.push('"entry" precisa ser um caminho relativo dentro do cartucho');
  }
  if (r.cover !== undefined && (typeof r.cover !== 'string' || !isSafeRelativePath(r.cover))) {
    errors.push('"cover" precisa ser um caminho relativo dentro do cartucho');
  }
  if (r.description !== undefined && typeof r.description !== 'string') {
    errors.push('"description" precisa ser texto');
  }
  if (r.author !== undefined && typeof r.author !== 'string') {
    errors.push('"author" precisa ser texto');
  }
  if (r.players !== undefined) {
    const p = r.players;
    const validNumber = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8;
    const ok = validNumber(p) || (Array.isArray(p) && p.length === 2 && p.every(validNumber));
    if (!ok) errors.push('"players" precisa ser um número (1–8) ou um intervalo [min, max]');
  }

  if (errors.length > 0) return { ok: false, errors };

  const manifest: CartridgeManifest = {
    id: r.id as string,
    name: (r.name as string).trim(),
    version: (r.version as string).trim(),
    entry: entry as string,
  };
  if (r.description !== undefined) manifest.description = r.description as string;
  if (r.cover !== undefined) manifest.cover = r.cover as string;
  if (r.players !== undefined) manifest.players = r.players as CartridgeManifest['players'];
  if (r.author !== undefined) manifest.author = r.author as string;
  return { ok: true, manifest, errors };
}
