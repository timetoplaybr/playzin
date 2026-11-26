import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_MAX_BYTES, type CartridgeManifest } from '@playzin/shared';

const GAME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * Arte de fundo de cada jogo (o "background" do playzin.json). Quando o cartucho entra, o console
 * guarda uma cópia em <dados>/backgrounds/<jogo>.<ext>: a página do jogo mostra a arte também dos
 * jogos que já passaram pelo console, com o cartucho fora (uma arte não cabe no armazenamento do
 * navegador, onde ficam as capas pequenas).
 */
export class BackgroundStore {
  constructor(
    private readonly dir: string,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  /** O cartucho entrou: guarda (ou atualiza, ou apaga) a cópia da arte. Diz se o jogo tem arte. */
  async remember(manifest: CartridgeManifest, rootPath: string | undefined): Promise<boolean> {
    if (!GAME_ID_PATTERN.test(manifest.id)) return false;
    if (!manifest.background || !rootPath) {
      // O jogo tirou a arte numa versão nova: tira a cópia velha também.
      await this.remove(manifest.id);
      return false;
    }
    const source = path.join(rootPath, manifest.background);
    const ext = path.extname(manifest.background).toLowerCase();
    if (!TYPES[ext]) return false;
    try {
      const { size } = await fs.stat(source);
      if (size > BACKGROUND_MAX_BYTES) {
        this.log.warn(`[fundo] arte de ${manifest.name} tem ${Math.round(size / 1000)} KB (máximo ${BACKGROUND_MAX_BYTES / 1000} KB): não vou usar`);
        await this.remove(manifest.id);
        return false;
      }
      await fs.mkdir(this.dir, { recursive: true });
      const target = path.join(this.dir, `${manifest.id}${ext}`);
      const temp = `${target}.${process.pid}.tmp`;
      await fs.copyFile(source, temp);
      await this.remove(manifest.id, ext); // outra extensão de uma versão anterior
      await fs.rename(temp, target);
      return true;
    } catch (err) {
      this.log.warn(`[fundo] não consegui guardar a arte de ${manifest.name}: ${(err as Error).message}`);
      return false;
    }
  }

  /** A arte guardada de um jogo, se houver. */
  async get(gameId: string): Promise<{ file: string; type: string } | null> {
    if (!GAME_ID_PATTERN.test(gameId)) return null;
    for (const [ext, type] of Object.entries(TYPES)) {
      const file = path.join(this.dir, `${gameId}${ext}`);
      try {
        await fs.access(file);
        return { file, type };
      } catch {
        /* tenta a próxima extensão */
      }
    }
    return null;
  }

  private async remove(gameId: string, keepExt?: string): Promise<void> {
    for (const ext of Object.keys(TYPES)) {
      if (ext === keepExt) continue;
      await fs.rm(path.join(this.dir, `${gameId}${ext}`), { force: true });
    }
  }
}
