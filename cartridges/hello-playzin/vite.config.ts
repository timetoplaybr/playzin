import { defineConfig } from 'vite';

export default defineConfig({
  // Obrigatório para cartuchos: caminhos relativos, porque o jogo é servido
  // em /cart/<slot>/ e não na raiz do site.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
