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

function postToLauncher(type: GameToLauncherMessage['type']): void {
  if (!isInsidePlayzin()) return;
  const msg: GameToLauncherMessage = { source: 'playzin-sdk', type };
  window.parent.postMessage(msg, window.location.origin);
}

/** Avise quando o jogo terminou de carregar (o launcher tira a tela de "carregando"). */
export function ready(): void {
  postToLauncher('ready');
}

/** Volta para o menu do console. Fora do Playzin, não faz nada. */
export function exitToMenu(): void {
  postToLauncher('exit');
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
