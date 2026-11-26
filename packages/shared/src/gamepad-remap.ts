/**
 * Remapeamento global dos botões (vale para todos os controles e todos os jogos).
 *
 * O remapeamento é uma lista `sources`: o botão lógico i (o que o jogo enxerga, no layout
 * "standard" da Gamepad API) lê o botão físico sources[i]. Sem remapeamento = [0, 1, 2, ...].
 * Só os 16 botões comuns (0–15); o Guide (16) é do console e nunca muda.
 */

export const REMAP_BUTTON_COUNT = 16;

/** Nome de cada botão do layout standard (como aparece na tela de remapear). */
export const REMAP_BUTTON_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3', '↑', '↓', '←', '→',
] as const;

export function identityRemap(): number[] {
  return Array.from({ length: REMAP_BUTTON_COUNT }, (_, i) => i);
}

/** Remapeamento válido: uma permutação de 0–15 (nenhum botão some, nenhum aparece duas vezes). */
export function isValidRemap(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== REMAP_BUTTON_COUNT) return false;
  const seen = new Set<number>();
  for (const n of value) {
    if (!Number.isInteger(n) || n < 0 || n >= REMAP_BUTTON_COUNT || seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}

export function isIdentityRemap(sources: readonly number[]): boolean {
  return sources.every((s, i) => s === i);
}

/**
 * Faz o botão lógico `logical` ler o físico `physical`. Para continuar uma permutação, o botão
 * lógico que lia `physical` passa a ler o físico antigo de `logical` (os dois trocam).
 */
export function assignButton(sources: readonly number[], logical: number, physical: number): number[] {
  const next = [...sources];
  const other = next.indexOf(physical);
  if (other === logical) return next;
  if (other >= 0) next[other] = next[logical]!;
  next[logical] = physical;
  return next;
}

/**
 * Modelo do controle a partir do Gamepad.id: "045e:0b13" (fabricante:produto) quando o navegador
 * informa (Chrome: "... Vendor: 045e Product: 0b13)"; Firefox: "045e-0b13-..."), senão o id
 * inteiro. Dois controles do mesmo modelo têm o mesmo; o mesmo controle tem sempre o mesmo.
 */
export function padModelKey(id: string): string {
  const chrome = /Vendor:\s*([0-9a-f]{4})\s+Product:\s*([0-9a-f]{4})/i.exec(id);
  if (chrome) return `${chrome[1]!.toLowerCase()}:${chrome[2]!.toLowerCase()}`;
  const firefox = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-/i.exec(id);
  if (firefox) return `${firefox[1]!.toLowerCase().padStart(4, '0')}:${firefox[2]!.toLowerCase().padStart(4, '0')}`;
  return id.trim();
}

/** Nome do modelo para a tela: sem o "(STANDARD GAMEPAD Vendor: ...)" que o navegador acrescenta. */
export function padModelName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '').trim() || id;
}

/**
 * Instala o remapeamento numa janela: navigator.getGamepads() passa a devolver os controles com
 * os botões trocados. Usada pelo launcher (na própria janela) e injetada pelo daemon no começo
 * do HTML de cada jogo, por isso é autossuficiente (o daemon envia o código desta função como
 * texto): nada de referências a outras coisas deste arquivo.
 *
 * `getRemap(id)` devolve o remapeamento de um controle (pelo Gamepad.id; cada modelo pode ter o
 * seu) e é consultada a cada chamada (mudanças valem na hora). Devolve a função original.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installGamepadRemap(win: any, getRemap: (padId: string) => readonly number[] | null | undefined): () => any[] {
  const nav = win && win.navigator;
  if (!nav || typeof nav.getGamepads !== 'function') return () => [];
  if (nav.__playzinRaw) return nav.__playzinRaw;
  const raw = nav.getGamepads.bind(nav);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const remapPad = (pad: any) => {
    let sources: readonly number[] | null | undefined = null;
    try {
      sources = getRemap(String(pad.id));
    } catch {
      sources = null;
    }
    if (!sources || !sources.length) return pad;
    return {
      id: pad.id,
      index: pad.index,
      connected: pad.connected,
      mapping: pad.mapping,
      timestamp: pad.timestamp,
      axes: pad.axes,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buttons: Array.prototype.map.call(pad.buttons, (b: any, i: number) => (i < sources!.length ? (pad.buttons[sources![i]!] ?? b) : b)),
      vibrationActuator: pad.vibrationActuator,
      hapticActuators: pad.hapticActuators,
    };
  };
  const getGamepads = function getGamepads() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Array.prototype.map.call(raw(), (p: any) => (p ? remapPad(p) : p));
  };
  Object.defineProperty(nav, 'getGamepads', { value: getGamepads, configurable: true, writable: true });
  Object.defineProperty(nav, '__playzinRaw', { value: raw, configurable: true });
  return raw;
}

/**
 * O script que o daemon injeta no jogo: pergunta ao launcher (a janela "pai", mesma origem) o
 * remapeamento de cada controle. Fora do console (sem launcher), nada muda.
 */
export function buildGamepadRemapScript(): string {
  const read =
    'function(id){try{var f=window.parent!==window?window.parent.__playzinRemapFor:null;return typeof f==="function"?f(id):null}catch(e){return null}}';
  return `<script data-playzin="gamepad-remap">(${installGamepadRemap.toString()})(window,${read});</script>`;
}
