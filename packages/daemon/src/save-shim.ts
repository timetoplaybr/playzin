/// <reference lib="dom" />
import type { SaveData } from './save-store.js';

/** Chaves do próprio launcher no localStorage (mesma origem): o jogo nunca mexe nelas. */
export const LAUNCHER_PREFIX = 'playzin:launcher:';

/**
 * Script injetado no HTML de entrada do jogo, antes de qualquer outro.
 *
 * Todos os cartuchos rodam na mesma origem (localhost:7777), então dividem o mesmo
 * localStorage. Como só um jogo roda por vez, o script:
 *  1. limpa o localStorage (menos as chaves do launcher) e coloca só os dados DESTE jogo,
 *     que o console guardou em disco;
 *  2. a cada setItem/removeItem/clear, manda o estado atual para o console (com debounce);
 *  3. faz o clear() do jogo apagar só os dados dele.
 *
 * O jogo não precisa saber de nada disso: ele continua usando localStorage normalmente.
 *
 * Migração (progresso de antes desta versão, que ficava só no navegador): na primeira vez,
 * o console guarda uma cópia de tudo ("legado"). Na primeira vez de cada jogo, ele recebe o
 * legado inteiro, mas só as chaves que o jogo de fato ler ou gravar entram no save dele.
 */
export type SaveMode =
  /** o console já tem o save deste jogo */
  | 'own'
  /** primeira vez deste jogo: parte dos dados antigos do navegador e fica só com o que usar */
  | 'legacy'
  /** primeira vez de qualquer jogo neste console: captura os dados antigos do navegador */
  | 'first';

export function buildSaveShim(opts: { slotId: string; gameId: string; initial: SaveData | null; mode: SaveMode }): string {
  const base = `/cart/${encodeURIComponent(opts.slotId)}/__playzin`;
  const config = {
    url: `${base}/save`,
    legacyUrl: `${base}/legacy`,
    gameId: opts.gameId,
    keep: LAUNCHER_PREFIX,
    initial: opts.initial,
    mode: opts.mode,
  };
  // JSON dentro de <script>: escapa "<" para um "</script>" nos dados não fechar a tag.
  const json = JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
  return `<script data-playzin="saves">(${shim.toString()})(${json});</script>`;
}

/* Roda no navegador, dentro do iframe do jogo. ES2017 simples, sem dependências. */
function shim(cfg: {
  url: string;
  legacyUrl: string;
  gameId: string;
  keep: string;
  initial: Record<string, string> | null;
  mode: 'own' | 'legacy' | 'first';
}): void {
  let ls: Storage;
  try {
    ls = window.localStorage;
  } catch {
    return; // sem localStorage: nada a fazer
  }
  const proto = Storage.prototype;
  const set = proto.setItem;
  const remove = proto.removeItem;
  const clear = proto.clear;
  const key = proto.key;
  const get = proto.getItem;
  const sdkPrefix = 'playzin:save:';
  const ownSdkPrefix = sdkPrefix + cfg.gameId + ':';
  /** Na migração, só entram no save as chaves que o jogo usar nesta sessão. */
  const migrating = cfg.mode !== 'own';
  const touched: Record<string, true> = {};

  /** Chaves que pertencem ao jogo atual (ignora o launcher e saves do SDK de outros jogos). */
  function gameKeys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = key.call(ls, i);
      if (k === null || k.indexOf(cfg.keep) === 0) continue;
      if (k.indexOf(sdkPrefix) === 0 && k.indexOf(ownSdkPrefix) !== 0) continue;
      if (migrating && !touched[k] && k.indexOf(ownSdkPrefix) !== 0) continue;
      out.push(k);
    }
    return out;
  }

  function allNonLauncherKeys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = key.call(ls, i);
      if (k !== null && k.indexOf(cfg.keep) !== 0) out.push(k);
    }
    return out;
  }

  function snapshot(): Record<string, string> {
    const data: Record<string, string> = {};
    for (const k of gameKeys()) {
      const v = get.call(ls, k);
      if (v !== null) data[k] = v;
    }
    return data;
  }

  // 0. Primeira vez neste console: guarda uma cópia do que já estava no navegador
  if (cfg.mode === 'first') {
    const legacy: Record<string, string> = {};
    for (const k of allNonLauncherKeys()) {
      const v = get.call(ls, k);
      if (v !== null) legacy[k] = v;
    }
    fetch(cfg.legacyUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: legacy }),
    }).catch(() => undefined);
  }

  // 1. Restaura os dados deste jogo (no modo "first", o navegador já está como deve)
  try {
    if (cfg.initial && cfg.mode !== 'first') {
      for (const k of allNonLauncherKeys()) remove.call(ls, k);
      for (const k of Object.keys(cfg.initial)) set.call(ls, k, cfg.initial[k]);
    }
  } catch {
    /* storage cheio ou bloqueado: o jogo segue com o que der */
  }

  // 2. Espelha as mudanças no console
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = JSON.stringify(snapshot());
  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const data = snapshot();
    const body = JSON.stringify({ data, at: Date.now() });
    const serialized = JSON.stringify(data);
    if (serialized === last) return;
    last = serialized;
    fetch(cfg.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60000, // sobrevive ao fechamento da página, se couber
    }).catch(() => {
      last = ''; // tenta de novo na próxima mudança
    });
  }
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  proto.getItem = function (this: Storage, k: string) {
    if (this === ls) touched[String(k)] = true;
    return get.call(this, k);
  };
  proto.setItem = function (this: Storage, k: string, v: string) {
    set.call(this, k, v);
    if (this === ls) {
      touched[String(k)] = true;
      schedule();
    }
  };
  proto.removeItem = function (this: Storage, k: string) {
    remove.call(this, k);
    if (this === ls) {
      touched[String(k)] = true;
      schedule();
    }
  };
  // 3. clear() apaga só os dados do jogo (nunca os do launcher)
  proto.clear = function (this: Storage) {
    if (this !== ls) return clear.call(this);
    for (const k of gameKeys()) remove.call(ls, k);
    schedule();
  };

  // O launcher usa isto para a última gravação quando o jogo é fechado.
  (window as unknown as { __playzinSaves: unknown }).__playzinSaves = { snapshot, flush, url: cfg.url };
  window.addEventListener('pagehide', flush);
}

/** Coloca o script logo depois de <head> (ou no começo do documento, se não houver head). */
export function injectIntoHtml(html: string, script: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return doctype[0] + script + html.slice(doctype[0].length);
  return script + html;
}
