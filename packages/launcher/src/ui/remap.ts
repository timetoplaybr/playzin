import { identityRemap, installGamepadRemap, isIdentityRemap, isValidRemap, padModelKey, padModelName } from '@playzin/shared';

const SETTING_KEY = 'playzin:launcher:remap';

/** De quem é um remapeamento: de todos os controles, ou de um modelo (padModelKey). */
export type RemapTarget = 'global' | string;

interface RemapConfig {
  /** Vale para todo controle cujo modelo não tem um próprio. */
  global: number[];
  /** Por modelo: o nome (para a tela) e o remapeamento, que vale no lugar do global. */
  models: Record<string, { name: string; sources: number[] }>;
}

interface RemapHost {
  /** O jogo (window.parent) pergunta aqui o remapeamento de cada controle, pelo Gamepad.id. */
  __playzinRemapFor?: (padId: string) => number[] | null;
}

let config: RemapConfig = load();
let rawGetter: () => (Gamepad | null)[] = () => [];
const listeners = new Set<() => void>();

/**
 * Liga o remapeamento no launcher. Chamar antes de qualquer leitura de controle: a partir daqui,
 * navigator.getGamepads() (e o SDK, que usa ele) já devolve os botões trocados.
 */
export function installRemap(): void {
  (window as unknown as RemapHost).__playzinRemapFor = remapFor;
  rawGetter = installGamepadRemap(window, remapFor) as () => (Gamepad | null)[];
}

/** O remapeamento de um controle: o do modelo dele, se houver, senão o de todos (null = nenhum). */
function remapFor(padId: string): number[] | null {
  const sources = config.models[padModelKey(padId)]?.sources ?? config.global;
  return isIdentityRemap(sources) ? null : sources;
}

/** Os controles como eles são de fato (sem remapeamento): a tela de remapear lê o botão físico. */
export function rawGamepads(): Gamepad[] {
  return [...rawGetter()].filter((p): p is Gamepad => p !== null && p.connected);
}

/** O que vale para o alvo: o próprio, ou (modelo sem o seu) o de todos os controles. */
export function getRemap(target: RemapTarget): readonly number[] {
  if (target === 'global') return config.global;
  return config.models[target]?.sources ?? config.global;
}

/** O modelo tem um remapeamento só dele? */
export function hasOwnRemap(target: RemapTarget): boolean {
  return target !== 'global' && target in config.models;
}

/** Algum botão trocado, em qualquer alvo? */
export function isRemapped(): boolean {
  return !isIdentityRemap(config.global) || Object.values(config.models).some((m) => !isIdentityRemap(m.sources));
}

/** Muda o remapeamento do alvo. Num modelo, `name` é o nome mostrado na tela. */
export function setRemap(target: RemapTarget, next: readonly number[], name?: string): void {
  if (!isValidRemap(next)) return;
  if (target === 'global') config = { ...config, global: [...next] };
  else {
    const label = name ?? config.models[target]?.name ?? target;
    config = { ...config, models: { ...config.models, [target]: { name: label, sources: [...next] } } };
  }
  save();
}

/** O modelo volta a seguir o remapeamento de todos os controles. */
export function clearModelRemap(target: string): void {
  if (!(target in config.models)) return;
  const models = { ...config.models };
  delete models[target];
  config = { ...config, models };
  save();
}

export interface RemapModel {
  key: string;
  name: string;
  /** Algum controle desse modelo ligado agora. */
  connected: boolean;
  own: boolean;
}

/** Modelos para escolher na tela: os ligados agora e os que já têm remapeamento guardado. */
export function remapModels(): RemapModel[] {
  const out = new Map<string, RemapModel>();
  for (const pad of rawGamepads()) {
    const key = padModelKey(pad.id);
    if (!out.has(key)) out.set(key, { key, name: padModelName(pad.id), connected: true, own: key in config.models });
  }
  for (const [key, m] of Object.entries(config.models)) {
    if (!out.has(key)) out.set(key, { key, name: m.name, connected: false, own: true });
  }
  return [...out.values()];
}

export function onRemapChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function save(): void {
  try {
    const empty = isIdentityRemap(config.global) && Object.keys(config.models).length === 0;
    if (empty) localStorage.removeItem(SETTING_KEY);
    else localStorage.setItem(SETTING_KEY, JSON.stringify({ format: 2, ...config }));
  } catch {
    /* sem localStorage: vale até o console desligar */
  }
  for (const l of listeners) l();
}

function load(): RemapConfig {
  const fresh: RemapConfig = { global: identityRemap(), models: {} };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTING_KEY) ?? 'null');
    // Versão anterior: só o remapeamento global (uma lista).
    if (isValidRemap(parsed)) return { global: parsed, models: {} };
    const p = parsed as Partial<RemapConfig> | null;
    if (!p || typeof p !== 'object') return fresh;
    const models: RemapConfig['models'] = {};
    for (const [key, m] of Object.entries(p.models ?? {})) {
      if (m && typeof m.name === 'string' && isValidRemap(m.sources)) models[key] = { name: m.name, sources: m.sources };
    }
    return { global: isValidRemap(p.global) ? p.global : identityRemap(), models };
  } catch {
    return fresh; // corrompido: volta ao padrão
  }
}
