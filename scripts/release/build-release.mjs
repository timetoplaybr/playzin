#!/usr/bin/env node
/**
 * Monta o pacote de uma versão do Playzin para a atualização pelo Wi-Fi.
 *
 *   npm run build                                   (antes: compila tudo)
 *   node scripts/release/build-release.mjs --out release \
 *     --base-url https://github.com/<dono>/<repo>/releases/download/v0.4.0 \
 *     [--notes-file notas.txt] [--key caminho/da/chave.pem]
 *
 * A chave privada vem de --key ou da variável PLAYZIN_RELEASE_KEY (o conteúdo PEM; no GitHub
 * Actions, o segredo de mesmo nome). Gera, em --out:
 *   playzin-<versão>.tar.gz  o sistema pronto: código compilado + dependências de produção
 *   latest.json              versão, endereço, tamanho, sha256, notas e a assinatura
 *
 * O pacote não tem nada de desenvolvimento (TypeScript, Vite, cartucho de exemplo): só o que o
 * console roda. As dependências são JavaScript puro, então o pacote montado num PC (x64) roda no
 * Raspberry Pi (arm64).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
/**
 * O tar do sistema. No Windows, o do próprio Windows: rodando do Git Bash, o primeiro tar do PATH
 * é o do Git, que lê "C:\..." como um endereço de rede ("C" seria o servidor) e falha.
 */
function tarCommand() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const out = path.resolve(arg('out', 'release'));
const baseUrl = arg('base-url');
if (!baseUrl) fail('Faltou --base-url (onde o pacote vai ficar publicado).');
const keyPem = arg('key') ? fs.readFileSync(arg('key'), 'utf8') : process.env.PLAYZIN_RELEASE_KEY;
if (!keyPem) fail('Faltou a chave privada: --key arquivo.pem ou a variável PLAYZIN_RELEASE_KEY.');
const notes = arg('notes-file') && fs.existsSync(arg('notes-file')) ? fs.readFileSync(arg('notes-file'), 'utf8').trim() : '';

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = rootPkg.version;
if (!/^\d+\.\d+\.\d+/.test(version ?? '')) fail(`Versão inválida no package.json: "${version}"`);

for (const built of ['packages/shared/dist/index.js', 'packages/daemon/dist/main.js', 'packages/launcher/dist/index.html']) {
  if (!fs.existsSync(path.join(ROOT, built))) fail(`${built} não existe: rode "npm run build" antes.`);
}

// ---- 1. Pasta do pacote, com o mesmo formato do projeto (o daemon acha o launcher pelo caminho)
const stage = path.join(out, 'stage');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(stage, rel), { recursive: true });
for (const pkg of ['shared', 'daemon']) {
  copy(`packages/${pkg}/package.json`);
  copy(`packages/${pkg}/dist`);
}
copy('packages/launcher/dist');
copy('scripts/pi');
fs.writeFileSync(
  path.join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'playzin',
      version,
      private: true,
      type: 'module',
      description: rootPkg.description,
      workspaces: ['packages/shared', 'packages/daemon'],
    },
    null,
    2,
  )}\n`,
);

// ---- 2. Só as dependências de produção (sem scripts de instalação)
console.log('• dependências de produção…');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], {
  cwd: stage,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// Os pacotes do próprio projeto entram em node_modules como link simbólico: troca por cópia
// (o pacote extrai igual em qualquer lugar, sem depender de links).
const own = path.join(stage, 'node_modules', '@playzin');
if (fs.existsSync(own)) {
  for (const name of fs.readdirSync(own)) {
    const link = path.join(own, name);
    if (!fs.lstatSync(link).isSymbolicLink()) continue;
    const target = fs.realpathSync(link);
    fs.rmSync(link, { force: true, recursive: true });
    fs.cpSync(target, link, { recursive: true, dereference: true });
  }
}

// ---- 3. O pacote
const file = `playzin-${version}.tar.gz`;
const tarball = path.join(out, file);
console.log(`• empacotando ${file}…`);
execFileSync(tarCommand(), ['-czf', tarball, '-C', stage, '.'], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });

const bytes = fs.readFileSync(tarball);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

// ---- 4. Assinatura, conferida com a chave pública que vai dentro do console
const { RELEASE_PUBLIC_KEY, signedMessage } = await import(pathToFileURL(path.join(ROOT, 'packages/daemon/dist/update/public-key.js')).href);
const message = Buffer.from(signedMessage(version, sha256));
let signature;
try {
  signature = crypto.sign(null, message, keyPem).toString('base64');
} catch (err) {
  fail(`Não consegui assinar com essa chave: ${err.message}`);
}
if (!crypto.verify(null, message, RELEASE_PUBLIC_KEY, Buffer.from(signature, 'base64'))) {
  fail('A chave privada não combina com a chave pública do console (packages/daemon/src/update/public-key.ts). Nada foi publicado.');
}

const manifest = {
  version,
  url: `${baseUrl.replace(/\/$/, '')}/${file}`,
  size: bytes.length,
  sha256,
  notes,
  publishedAt: new Date().toISOString(),
  signature,
};
fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ Playzin ${version}: ${file} (${(bytes.length / 1_000_000).toFixed(1)} MB), assinado e conferido.`);
