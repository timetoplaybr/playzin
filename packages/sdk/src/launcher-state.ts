import type { LauncherToGameMessage } from '@playzin/shared';

/**
 * Estado que o launcher controla de fora do jogo: hoje, só "pausado pelo menu rápido".
 * O PlayerInput consulta isto para não deixar o jogo ver os botões usados no menu.
 */
let paused = false;
let listening = false;
const handlers = new Set<(type: LauncherToGameMessage['type']) => void>();

function listen(): void {
  if (listening || typeof window === 'undefined' || window.parent === window) return;
  listening = true;
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const data = event.data as Partial<LauncherToGameMessage> | undefined;
    if (data?.source !== 'playzin-launcher' || (data.type !== 'pause' && data.type !== 'resume')) return;
    paused = data.type === 'pause';
    for (const handler of handlers) handler(data.type);
  });
}

// Começa a escutar assim que o SDK é carregado, mesmo que o jogo não registre nada.
listen();

/** O menu rápido do console está aberto por cima do jogo? */
export function isPausedByLauncher(): boolean {
  return paused;
}

/** Avisos de pausa/retomada do launcher. Devolve uma função que cancela. */
export function onLauncherMessage(handler: (type: LauncherToGameMessage['type']) => void): () => void {
  listen();
  handlers.add(handler);
  return () => handlers.delete(handler);
}
