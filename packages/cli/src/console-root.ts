import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './log.js';

/**
 * Onde fica o "slot de cartucho" do console de desenvolvimento (a pasta dev-slot
 * que o daemon observa). Ordem: --slot, variável PLAYZIN_DEV_SLOT, e por fim o
 * monorepo do Playzin de onde este comando veio (instalado por pasta, o pacote é
 * um link para playzin/packages/cli).
 */
export function resolveDevSlot(flag?: string): string {
  const explicit = flag ?? process.env.PLAYZIN_DEV_SLOT;
  if (explicit) return path.resolve(explicit);

  const here = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
  let dir = here;
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; workspaces?: unknown };
        if (pkg.name === 'playzin' && pkg.workspaces) return path.join(dir, 'dev-slot');
      } catch {
        /* package.json inválido: continua subindo */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(
    'Não encontrei o console de desenvolvimento (a pasta dev-slot do Playzin).',
    'Instale o pacote pela pasta do Playzin (npm install -D ../playzin/packages/cli) ou informe --slot <pasta>.',
  );
}
