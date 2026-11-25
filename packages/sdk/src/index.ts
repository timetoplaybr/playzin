import type { GameToLauncherMessage } from '@playzin/shared';

export * from './input.js';
export { isPausedByLauncher, onLauncherMessage } from './launcher-state.js';
export type { CartridgeManifest } from '@playzin/shared';

/**
 * O jogo está rodando dentro do console Playzin?
 * Fora dele (ex.: no navegador durante o desenvolvimento), as funções do SDK
 * continuam funcionando, só que sem falar com o launcher.
 */
export function isInsidePlayzin(): boolean {
  try {
    return window.parent !== window && new URLSearchParams(window.location.search).has('playzin');
  } catch {
    return false;
  }
}

type Payload<T> = T extends { type: infer K } ? Omit<T, 'source' | 'type'> & { type: K } : never;

function postToLauncher(payload: Payload<GameToLauncherMessage>): void {
  if (!isInsidePlayzin()) return;
  const msg = { source: 'playzin-sdk', ...payload } as GameToLauncherMessage;
  window.parent.postMessage(msg, window.location.origin);
}

/**
 * Desbloqueia uma conquista declarada no playzin.json ("achievements"). O console guarda no
 * perfil de quem está jogando e mostra o aviso por cima do jogo, só na primeira vez: pode chamar
 * de novo sem medo (ex.: a cada frame em que a condição vale). Fora do Playzin, não faz nada.
 */
export function unlockAchievement(id: string): void {
  if (unlockedHere().has(id)) return;
  unlockedHere().add(id);
  postToLauncher({ type: 'achievement', id });
}

/** O perfil que está jogando já tem esta conquista? (Fora do Playzin: só as desta partida.) */
export function isAchievementUnlocked(id: string): boolean {
  if (unlockedHere().has(id)) return true;
  try {
    const list = (window.parent as unknown as { __playzinAchievements?: string[] }).__playzinAchievements;
    return Array.isArray(list) && list.includes(id);
  } catch {
    return false;
  }
}

/** Desbloqueadas nesta página (evita mandar o mesmo pedido mil vezes). */
let sent: Set<string> | undefined;
function unlockedHere(): Set<string> {
  return (sent ??= new Set());
}

/** Avise quando o jogo terminou de carregar (o launcher tira a tela de "carregando"). */
export function ready(): void {
  postToLauncher({ type: 'ready' });
}

/** Volta para o menu do console. Fora do Playzin, não faz nada. */
export function exitToMenu(): void {
  postToLauncher({ type: 'exit' });
}

/**
 * Saves isolados por jogo. Hoje usa localStorage com um prefixo por id do jogo
 * (todos os cartuchos rodam na mesma origem, então o prefixo evita que um jogo
 * leia o save do outro). A API não muda quando os saves migrarem para o
 * próprio cartucho ou para o daemon.
 */
export interface SaveStore {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
  clear(): void;
}

export function createSaveStore(gameId: string): SaveStore {
  const prefix = `playzin:save:${gameId}:`;
  const storage = safeStorage();
  return {
    get<T>(key: string, fallback: T): T {
      const raw = storage?.getItem(prefix + key);
      if (raw == null) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    },
    set<T>(key: string, value: T): void {
      try {
        storage?.setItem(prefix + key, JSON.stringify(value));
      } catch {
        /* storage cheio ou indisponível: não derruba o jogo */
      }
    },
    remove(key: string): void {
      storage?.removeItem(prefix + key);
    },
    clear(): void {
      if (!storage) return;
      for (let i = storage.length - 1; i >= 0; i--) {
        const k = storage.key(i);
        if (k?.startsWith(prefix)) storage.removeItem(k);
      }
    },
  };
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
