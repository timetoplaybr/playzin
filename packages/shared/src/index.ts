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

/** Mensagens que o daemon envia ao launcher via WebSocket. */
export type ServerMessage =
  | { type: 'state'; cartridge: CartridgeInfo | null }
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
