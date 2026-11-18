import { defineConfig } from 'tsup';

// Tudo empacotado num arquivo só, sem dependências em tempo de execução:
// o pacote funciona instalado por pasta (npm install -D ../playzin/packages/cli),
// pelo GitHub ou pelo npm, sem precisar dos outros pacotes do monorepo.
export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node20',
    noExternal: [/.*/],
    banner: { js: '#!/usr/bin/env node' },
    clean: true,
  },
  {
    entry: { sdk: 'src/sdk.ts' },
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    noExternal: [/.*/],
    dts: { resolve: true },
  },
]);
