import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { MANIFEST_FILE, type CartridgeManifest } from '@playzin/shared';
import { inspectCartridge, isFile } from './checks.js';
import { resolveDevSlot } from './console-root.js';
import { c, CliError, formatBytes, log } from './log.js';
import { loadProject, readManifest, relative, savePackageJson, slugify, writeManifest, type GameProject } from './project.js';

const VERSION = '0.1.0';

const HELP = `
${c.bold('playzin')} ${c.dim(VERSION)} — cartuchos para o console Playzin

${c.bold('Uso')} (dentro da pasta do jogo):
  playzin init              prepara o jogo: playzin.json, scripts e dicas de integração
  playzin build             compila (npm run build) e confere se o cartucho está pronto
  playzin check             só confere o build atual, sem compilar
  playzin insert            compila e "insere" no console de desenvolvimento (dev-slot)
  playzin eject             remove este jogo do console de desenvolvimento
  playzin pack <destino>    compila, limpa o pendrive e grava o cartucho nele

${c.bold('Opções')}
  --no-build                usa o build que já existe (build, insert, pack)
  --out <pasta>             pasta do build (padrão: dist)
  --slot <pasta>            pasta do console de desenvolvimento (padrão: dev-slot do Playzin)
  --players <n | min-max>   jogadores no init (ex.: 2 ou 1-2)
  --all                     eject: remove todos os cartuchos do dev-slot
  --force                   init: sobrescreve o playzin.json · pack: grava mesmo com outros arquivos no pendrive
`;

/** Pastas de sistema que o macOS/Windows criam em pendrives: nunca mexemos nelas. */
const SYSTEM_ENTRIES = new Set(['.Spotlight-V100', '.fseventsd', '.Trashes', '.TemporaryItems', 'System Volume Information', '$RECYCLE.BIN']);

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'no-build': { type: 'boolean', default: false },
      out: { type: 'string', default: 'dist' },
      slot: { type: 'string' },
      players: { type: 'string' },
      all: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const [command, ...rest] = positionals;

  if (values.version) return void console.log(VERSION);
  if (values.help || !command || command === 'help') return void console.log(HELP);

  const opts = { ...values, build: !values['no-build'] };
  switch (command) {
    case 'init':
      return init(loadProject(process.cwd(), opts.out), opts);
    case 'build':
      return void build(loadProject(process.cwd(), opts.out), opts);
    case 'check':
      return void build(loadProject(process.cwd(), opts.out), { ...opts, build: false });
    case 'insert':
      return insert(loadProject(process.cwd(), opts.out), opts);
    case 'eject':
      return eject(opts);
    case 'pack':
      return pack(loadProject(process.cwd(), opts.out), rest[0], opts);
    default:
      throw new CliError(`Comando desconhecido: "${command}".`, 'Veja os comandos com: playzin help');
  }
}

// ---------------------------------------------------------------- init

function init(project: GameProject, opts: { players?: string; force: boolean }): void {
  log.step(`Preparando ${c.bold(project.pkg.name ?? path.basename(project.root))} para o Playzin`);

  // 1. playzin.json
  if (fs.existsSync(project.manifestSource) && !opts.force) {
    const current = readManifest(project.manifestSource);
    log.ok(`${relative(project.manifestSource)} já existe (${current.name}); mantido. Use --force para recriar.`);
  } else {
    const coverExists = isFile(path.join(project.publicDir, 'cover.png'));
    const manifest: CartridgeManifest = {
      id: slugify(project.pkg.name ?? path.basename(project.root)),
      name: titleFromHtml(project.root) ?? humanize(project.pkg.name ?? path.basename(project.root)),
      version: project.pkg.version ?? '0.1.0',
      entry: 'index.html',
      ...(coverExists ? { cover: 'cover.png' } : {}),
      players: parsePlayers(opts.players),
    };
    writeManifest(project.manifestSource, manifest);
    log.ok(`Criei ${relative(project.manifestSource)} (id "${manifest.id}", "${manifest.name}"). Revise o nome à vontade.`);
    if (!coverExists) log.warn('Sem capa ainda: coloque uma public/cover.png 512×512 e adicione "cover": "cover.png".');
  }

  // 2. scripts
  const scripts = (project.pkg.scripts ??= {});
  const wanted: Record<string, string> = { cartucho: 'playzin insert', 'cartucho:pendrive': 'playzin pack' };
  const added = Object.entries(wanted).filter(([k]) => !scripts[k]);
  for (const [k, v] of added) scripts[k] = v;
  if (added.length) {
    savePackageJson(project);
    log.ok(`Adicionei os scripts ${added.map(([k]) => `"${k}"`).join(' e ')} ao package.json.`);
  } else {
    log.ok('Os scripts "cartucho" e "cartucho:pendrive" já existem.');
  }
  if (!scripts.build) log.warn('O package.json não tem script "build": o Playzin precisa dele para compilar o jogo.');

  // 3. Vite com caminhos relativos
  const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']
    .map((f) => path.join(project.root, f))
    .find(isFile);
  if (viteConfig && !/\bbase\s*:\s*['"]\.\/['"]/.test(fs.readFileSync(viteConfig, 'utf8'))) {
    log.warn(`Adicione ${c.bold("base: './'")} em ${path.basename(viteConfig)}: o console serve o jogo em /cart/<slot>/.`);
  } else if (viteConfig) {
    log.ok(`${path.basename(viteConfig)} já usa base: './'.`);
  }

  console.log(`
${c.bold('Próximos passos')}
  1. No código do jogo (opcional, recomendado):
       import { ready, exitToMenu, isInsidePlayzin } from 'playzin/sdk';
       ready();        ${c.dim('// quando o jogo terminar de carregar')}
       exitToMenu();   ${c.dim('// numa opção "Voltar ao console" do menu')}
  2. Teste no console:       ${c.cyan('npm run cartucho')}   ${c.dim('(com o Playzin rodando: npm start na pasta dele)')}
  3. Grave num pendrive:     ${c.cyan('npm run cartucho:pendrive -- /Volumes/NOME_DO_PENDRIVE')}
`);
}

// ---------------------------------------------------------------- build / check

function build(project: GameProject, opts: { build: boolean }): CartridgeManifest {
  // A versão do package.json é a fonte da verdade: o playzin.json acompanha.
  const source = readManifest(project.manifestSource);
  if (project.pkg.version && source.version !== project.pkg.version) {
    writeManifest(project.manifestSource, { ...source, version: project.pkg.version });
    log.ok(`Versão do cartucho sincronizada: ${source.version} → ${project.pkg.version}`);
  }

  if (opts.build) {
    if (!project.pkg.scripts?.build) throw new CliError('O package.json não tem script "build".');
    log.step('Compilando o jogo (npm run build)…');
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: project.root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) throw new CliError('O build do jogo falhou (veja o erro acima).');
  }

  if (!fs.existsSync(project.outDir)) {
    throw new CliError(`A pasta do build (${relative(project.outDir)}) não existe.`, 'Rode "playzin build" ou ajuste --out.');
  }
  if (!fs.existsSync(path.join(project.outDir, MANIFEST_FILE))) {
    throw new CliError(
      `O build não tem o ${MANIFEST_FILE}.`,
      `Ele precisa estar em public/ para o Vite copiar (está em ${relative(project.manifestSource)}?).`,
    );
  }

  const report = inspectCartridge(project.outDir);
  for (const w of report.warnings) log.warn(w);
  if (report.errors.length) {
    for (const e of report.errors) log.error(e);
    throw new CliError('O cartucho ainda não está pronto para o console.');
  }
  const { manifest } = report;
  log.ok(
    `Cartucho pronto: ${c.bold(manifest.name)} v${manifest.version} ` +
      c.dim(`(${report.files} arquivos, ${formatBytes(report.bytes)}, em ${relative(project.outDir)})`),
  );
  return manifest;
}

// ---------------------------------------------------------------- insert / eject

function insert(project: GameProject, opts: { build: boolean; slot?: string }): void {
  const manifest = build(project, opts);
  const slot = resolveDevSlot(opts.slot);
  fs.mkdirSync(slot, { recursive: true });
  const dest = path.join(slot, manifest.id);
  // O console tem um slot só: "trocar a fita" tira o cartucho que estiver lá antes.
  for (const other of fs.readdirSync(slot)) {
    if (other === manifest.id || other === '.gitkeep' || other.startsWith('.')) continue;
    fs.rmSync(path.join(slot, other), { recursive: true, force: true });
    log.ok(`Cartucho anterior removido do console: ${other}`);
  }
  // Copia para uma pasta temporária e renomeia: o console nunca vê um cartucho pela metade.
  const tmp = path.join(slot, `.${manifest.id}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(project.outDir, tmp, { recursive: true });
  const replacing = fs.existsSync(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  // Já estava inserido: o console nota o playzin.json novo e troca a fita sozinho (o jogo aberto volta ao menu).
  log.ok(`${replacing ? `Reinserido (v${manifest.version})` : 'Inserido'} no console de desenvolvimento ${c.dim(`(${dest})`)}`);
  log.info(c.dim('Abra http://127.0.0.1:7777 com o Playzin rodando (npm start na pasta dele).'));
}

function eject(opts: { all: boolean; slot?: string; out: string }): void {
  const slot = resolveDevSlot(opts.slot);
  if (!fs.existsSync(slot)) return log.ok('Nenhum cartucho inserido.');
  let targets: string[];
  if (opts.all) {
    targets = fs.readdirSync(slot).filter((e) => e !== '.gitkeep');
  } else {
    const manifest = readManifest(loadProject(process.cwd(), opts.out).manifestSource);
    targets = fs.existsSync(path.join(slot, manifest.id)) ? [manifest.id] : [];
  }
  if (targets.length === 0) return log.ok('Este jogo não está inserido.');
  for (const t of targets) {
    fs.rmSync(path.join(slot, t), { recursive: true, force: true });
    if (!t.startsWith('.')) log.ok(`Removido: ${t}`);
  }
}

// ---------------------------------------------------------------- pack

function pack(project: GameProject, destination: string | undefined, opts: { build: boolean; force: boolean }): void {
  if (!destination) {
    throw new CliError('Informe onde está o pendrive.', 'Ex.: npm run cartucho:pendrive -- /Volumes/PLAYZIN   (no Windows: E:\\)');
  }
  const dest = path.resolve(destination);
  if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
    throw new CliError(`"${dest}" não existe ou não é uma pasta.`, 'O pendrive está plugado? Confira o nome em /Volumes (Mac) ou a letra da unidade (Windows).');
  }
  // Proteções contra apagar a pasta errada.
  const root = path.parse(dest).root;
  if (dest === root && process.platform !== 'win32') throw new CliError('Destino é a raiz do sistema: abortado.');
  // No Windows a raiz de uma unidade (E:\) é justamente o pendrive, mas nunca a unidade do sistema.
  const systemDrive = (process.env.SystemDrive ?? 'C:').toUpperCase();
  if (process.platform === 'win32' && root.toUpperCase().startsWith(systemDrive)) {
    throw new CliError(`Destino fica na unidade do sistema (${systemDrive}): abortado.`);
  }
  if (dest === path.resolve(process.env.HOME ?? process.env.USERPROFILE ?? '~')) throw new CliError('Destino é a sua pasta pessoal: abortado.');
  const inside = path.relative(project.root, dest);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) throw new CliError('Destino fica dentro do próprio projeto: abortado.');

  const entries = fs.readdirSync(dest).filter((e) => !SYSTEM_ENTRIES.has(e) && !e.startsWith('._') && e !== '.DS_Store');
  if (entries.some((e) => ['package.json', '.git', 'node_modules'].includes(e))) {
    throw new CliError(`"${dest}" parece uma pasta de projeto, não um pendrive: abortado.`);
  }
  const isCartridge = entries.includes(MANIFEST_FILE);
  if (entries.length > 0 && !isCartridge && !opts.force) {
    throw new CliError(
      `O destino tem arquivos que não são de um cartucho Playzin:\n  ${entries.slice(0, 8).join('\n  ')}${entries.length > 8 ? '\n  …' : ''}`,
      'Para apagar tudo e gravar o cartucho mesmo assim, use --force.',
    );
  }

  const manifest = build(project, opts);

  if (entries.length > 0) {
    const previous = isCartridge ? safeName(path.join(dest, MANIFEST_FILE)) : undefined;
    log.step(previous ? `Removendo o cartucho anterior (${previous})…` : 'Limpando o pendrive…');
    for (const e of entries) fs.rmSync(path.join(dest, e), { recursive: true, force: true });
  }
  log.step(`Gravando em ${dest}…`);
  fs.cpSync(project.outDir, dest, { recursive: true });
  const check = inspectCartridge(dest);
  if (check.errors.length) throw new CliError(`A cópia no pendrive ficou com problemas: ${check.errors.join('; ')}`);
  log.ok(`Cartucho ${c.bold(manifest.name)} v${manifest.version} gravado. Pode ejetar o pendrive e plugar no console.`);
}

// ---------------------------------------------------------------- utilidades

function parsePlayers(value: string | undefined): CartridgeManifest['players'] {
  if (!value) return 1;
  const range = value.match(/^(\d)\s*-\s*(\d)$/);
  if (range) return [Number(range[1]), Number(range[2])];
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 8) return n;
  throw new CliError(`--players inválido: "${value}" (use um número de 1 a 8 ou um intervalo como 1-2).`);
}

function titleFromHtml(root: string): string | undefined {
  const file = path.join(root, 'index.html');
  if (!isFile(file)) return undefined;
  const m = fs.readFileSync(file, 'utf8').match(/<title>([^<]+)<\/title>/i);
  const title = m?.[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return title && title.length <= 80 ? title : undefined;
}

function humanize(name: string): string {
  return name
    .replace(/^@[^/]+\//, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 80);
}

function safeName(file: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string }).name;
  } catch {
    return undefined;
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof CliError) {
    log.error(err.message);
    if (err.hint) log.info(c.dim(err.hint));
  } else if ((err as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    log.error((err as Error).message);
    log.info(c.dim('Veja as opções com: playzin help'));
  } else {
    log.error(`Erro inesperado: ${(err as Error).stack ?? err}`);
  }
  process.exit(1);
});
