#!/usr/bin/env node
/**
 * Gera um par de chaves ed25519 para assinar as versões do Playzin.
 *
 *   node scripts/release/keygen.mjs [pasta]      (padrão: ~/.playzin)
 *
 * - release-signing-key.pem: a chave PRIVADA. Nunca vai para o git. Guarde uma cópia em lugar
 *   seguro e coloque o conteúdo no segredo PLAYZIN_RELEASE_KEY do repositório no GitHub.
 * - a chave pública aparece na tela: ela vai em packages/daemon/src/update/public-key.ts.
 * Não sobrescreve uma chave que já existe.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? path.join(os.homedir(), '.playzin'));
const file = path.join(dir, 'release-signing-key.pem');
if (fs.existsSync(file)) {
  console.error(`✗ ${file} já existe: não vou sobrescrever (apague à mão se for mesmo trocar a chave).`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`✓ Chave privada em ${file}\n\nChave pública (para public-key.ts):\n`);
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
