const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

export const log = {
  step: (msg: string) => console.log(`${c.cyan('›')} ${msg}`),
  ok: (msg: string) => console.log(`${c.green('✓')} ${msg}`),
  warn: (msg: string) => console.log(`${c.yellow('!')} ${msg}`),
  error: (msg: string) => console.error(`${c.red('✗')} ${msg}`),
  info: (msg: string) => console.log(`  ${msg}`),
};

/** Erro "esperado" (cartucho inválido, pasta errada...): mostra a mensagem sem stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
