import fs from 'node:fs';
import path from 'node:path';
import { BACKGROUND_MAX_BYTES, MANIFEST_FILE, type CartridgeManifest } from '@playzin/shared';
import { readManifest } from './project.js';

const MAX_COVER_BYTES = 400_000;

export interface CartridgeReport {
  manifest: CartridgeManifest;
  errors: string[];
  warnings: string[];
  files: number;
  bytes: number;
}

/**
 * Confere uma pasta de cartucho (o build do jogo) do jeito que o console vai ler.
 * Erros impedem o jogo de rodar no Playzin; avisos são só recomendações.
 */
export function inspectCartridge(dir: string): CartridgeReport {
  const manifest = readManifest(path.join(dir, MANIFEST_FILE));
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- arquivo de entrada
  const entryPath = path.join(dir, manifest.entry);
  if (!isFile(entryPath)) {
    errors.push(`O arquivo de entrada "${manifest.entry}" não existe no build.`);
  } else if (/\.html?$/i.test(manifest.entry)) {
    const html = fs.readFileSync(entryPath, 'utf8');
    const absolute = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi)].map((m) => m[1]);
    if (absolute.length > 0) {
      errors.push(
        `O HTML usa caminhos absolutos (${absolute.slice(0, 3).join(', ')}${absolute.length > 3 ? '…' : ''}). ` +
          `No console o jogo roda em /cart/<slot>/, então eles quebram. No Vite, use base: './'.`,
      );
    }
    const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
    if (external.length > 0) {
      warnings.push(
        `O HTML carrega arquivos da internet (${external.slice(0, 2).join(', ')}). ` +
          'O console pode estar sem rede: prefira empacotar tudo no jogo.',
      );
    }
  }

  // --- capa
  if (!manifest.cover) {
    warnings.push('Sem capa: o console vai gerar uma com as iniciais. Coloque uma cover.png 512×512 em public/.');
  } else {
    const coverPath = path.join(dir, manifest.cover);
    if (!isFile(coverPath)) {
      errors.push(`A capa "${manifest.cover}" não existe no build.`);
    } else {
      const size = fs.statSync(coverPath).size;
      if (size > MAX_COVER_BYTES) {
        warnings.push(`A capa tem ${Math.round(size / 1000)} KB; acima de 400 KB o console não guarda cópia dela no histórico.`);
      }
      const dims = imageSize(coverPath);
      if (dims && dims.width !== dims.height) {
        warnings.push(`A capa é ${dims.width}×${dims.height}; no console ela aparece num quadrado (recomendado 512×512).`);
      } else if (dims && dims.width < 256) {
        warnings.push(`A capa é pequena (${dims.width}×${dims.height}); recomendado 512×512.`);
      }
    }
  }

  // --- arte de fundo (opcional): aparece atrás do topo da página do jogo
  if (manifest.background) {
    const bgPath = path.join(dir, manifest.background);
    if (!isFile(bgPath)) {
      errors.push(`A arte de fundo "${manifest.background}" não existe no build.`);
    } else {
      const size = fs.statSync(bgPath).size;
      if (size > BACKGROUND_MAX_BYTES) {
        warnings.push(
          `A arte de fundo tem ${Math.round(size / 1000)} KB; acima de ${BACKGROUND_MAX_BYTES / 1000} KB o console não usa. ` +
            'Salve em JPG (qualidade ~80) em 1920×1080.',
        );
      }
      const dims = imageSize(bgPath);
      if (dims && Math.abs(dims.width / dims.height - 16 / 9) > 0.02) {
        warnings.push(`A arte de fundo é ${dims.width}×${dims.height}; ela cobre a tela da TV (16:9) e vai ser cortada. Recomendado 1920×1080.`);
      } else if (dims && dims.width < 1280) {
        warnings.push(`A arte de fundo é pequena (${dims.width}×${dims.height}); na TV fica borrada. Recomendado 1920×1080.`);
      }
    }
  }

  const { files, bytes } = folderStats(dir);
  return { manifest, errors, warnings, files, bytes };
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function folderStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

/** Largura/altura de PNG ou JPEG lendo só o cabeçalho (sem dependências). */
export function imageSize(file: string): { width: number; height: number } | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const buf = head.subarray(0, n);
    // PNG: assinatura + IHDR
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: procura o marcador SOFn
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return undefined;
        const marker = buf[i + 1];
        const length = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}
