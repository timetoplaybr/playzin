import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, validateManifest, type CartridgeManifest } from '@playzin/shared';
import { CliError } from './log.js';

/** O projeto de jogo na pasta atual (onde está o package.json). */
export interface GameProject {
  root: string;
  pkgPath: string;
  pkg: { name?: string; version?: string; scripts?: Record<string, string>; [k: string]: unknown };
  /** Pasta copiada para o build (no Vite, "public/"). É onde fica o playzin.json "fonte". */
  publicDir: string;
  /** Saída do build: é ela que vira o cartucho. */
  outDir: string;
  manifestSource: string;
}

export function loadProject(cwd: string, outDir = 'dist'): GameProject {
  const root = findUp(cwd, 'package.json');
  if (!root) {
    throw new CliError('Nenhum package.json encontrado aqui.', 'Rode o comando dentro da pasta do jogo.');
  }
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as GameProject['pkg'];
  const publicDir = path.join(root, 'public');
  return {
    root,
    pkgPath,
    pkg,
    publicDir,
    outDir: path.resolve(root, outDir),
    manifestSource: path.join(publicDir, MANIFEST_FILE),
  };
}

export function savePackageJson(project: GameProject): void {
  fs.writeFileSync(project.pkgPath, JSON.stringify(project.pkg, null, 2) + '\n');
}

/** Lê e valida um playzin.json. */
export function readManifest(file: string): CartridgeManifest {
  if (!fs.existsSync(file)) {
    throw new CliError(`Não encontrei ${relative(file)}.`, 'Rode "npx playzin init" para criar.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${relative(file)} não é um JSON válido: ${(err as Error).message}`);
  }
  const result = validateManifest(raw);
  if (!result.ok || !result.manifest) {
    throw new CliError(`${relative(file)} tem problemas:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.manifest;
}

export function writeManifest(file: string, manifest: CartridgeManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Ordem fixa dos campos, para o arquivo ficar previsível no git.
  const ordered: Record<string, unknown> = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    entry: manifest.entry,
  };
  for (const key of ['description', 'cover', 'players', 'author', 'achievements'] as const) {
    if (manifest[key] !== undefined) ordered[key] = manifest[key];
  }
  // (intervalo de jogadores numa linha só: "players": [1, 2])
  const json = JSON.stringify(ordered, null, 2).replace(/\[\s+(\d+),\s+(\d+)\s+\]/, '[$1, $2]');
  fs.writeFileSync(file, json + '\n');
}

/** "@timetoplay/Meu Jogo!" → "meu-jogo" (formato aceito pelo campo "id"). */
export function slugify(name: string): string {
  const slug = name
    .replace(/^@[^/]+\//, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return slug || 'meu-jogo';
}

export function relative(file: string): string {
  return path.relative(process.cwd(), file) || '.';
}

function findUp(start: string, file: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, file))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
