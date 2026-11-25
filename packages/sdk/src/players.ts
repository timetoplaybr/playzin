/**
 * Ordem dos jogadores: qual controle é o Jogador 1, 2, 3, 4.
 *
 * Sem ordem definida, vale a ordem em que os controles conectaram. No console, a tela
 * Controles → "Mudar a ordem dos jogadores" define a ordem (cada um aperta A no seu controle),
 * e o launcher a publica na própria janela. Os jogos (iframe da mesma origem) leem de lá.
 */

interface OrderHost {
  /** Gamepad.index de cada jogador, na ordem (Jogador 1 primeiro). */
  __playzinPadOrder?: number[];
}

/** A ordem publicada pelo launcher (a janela do launcher é o "parent" do jogo; no launcher, ela mesma). */
function publishedOrder(): number[] | undefined {
  try {
    const order = (window.parent as unknown as OrderHost).__playzinPadOrder;
    return Array.isArray(order) ? order : undefined;
  } catch {
    return undefined; // jogo rodando dentro de outra página (origem diferente): sem ordem do console
  }
}

/** Controles conectados, na ordem em que foram conectados (sem buracos). */
export function getConnectedGamepads(): Gamepad[] {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  return [...navigator.getGamepads()].filter((p): p is Gamepad => p !== null && p.connected);
}

/**
 * Controle de cada jogador: [0] é o Jogador 1. Com uma ordem definida, um jogador cujo controle
 * desligou fica com um buraco (undefined), sem empurrar os outros de lugar; controles que não
 * estão na ordem entram depois dos que estão.
 */
export function getPlayerGamepads(): (Gamepad | undefined)[] {
  const pads = getConnectedGamepads();
  const order = publishedOrder();
  if (!order?.length) return pads;
  const byIndex = new Map(pads.map((p) => [p.index, p]));
  const players: (Gamepad | undefined)[] = order.map((index) => byIndex.get(index));
  for (const pad of pads) if (!order.includes(pad.index)) players.push(pad);
  // Sem buracos no fim (ex.: o último jogador desligou o controle).
  while (players.length && players[players.length - 1] === undefined) players.pop();
  return players;
}

/** Controle do jogador (0 = Jogador 1), se estiver conectado. */
export function getPlayerGamepad(player: number): Gamepad | undefined {
  return getPlayerGamepads()[player];
}

/** Só para o launcher: publica a ordem dos jogadores (Gamepad.index de cada um). null limpa. */
export function setPlayerOrder(order: number[] | null): void {
  (window as unknown as OrderHost).__playzinPadOrder = order ? [...order] : undefined;
}
