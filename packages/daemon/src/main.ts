import fs from 'node:fs';
import { CartridgeManager } from './cartridge-manager.js';
import { loadConfig } from './config.js';
import { SaveStore } from './save-store.js';
import { createServer } from './server.js';
import { DirectorySource } from './sources/directory.js';
import type { CartridgeSource } from './sources/types.js';
import { UdisksSource } from './sources/udisks.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new CartridgeManager({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });
  const saves = new SaveStore(config.savesDir);
  await saves.init();
  const app = await createServer(config, manager, saves);

  const sources: CartridgeSource[] = [];
  const wantUdisks =
    config.sourceMode === 'udisks' || (config.sourceMode === 'auto' && (await UdisksSource.isAvailable()));
  if (wantUdisks) sources.push(new UdisksSource());
  if (config.sourceMode !== 'udisks') {
    // Garante que a pasta de desenvolvimento exista para os scripts cart:insert/eject.
    for (const dir of config.slotDirs) {
      if (dir.endsWith('dev-slot')) fs.mkdirSync(dir, { recursive: true });
    }
    sources.push(new DirectorySource(config.slotDirs, config.pollIntervalMs));
  }

  for (const source of sources) {
    manager.attach(source);
    await source.start();
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Playzin pronto em http://${config.host}:${config.port}`);
  app.log.info(`fontes de cartucho: ${sources.map((s) => s.name).join(', ')}`);
  app.log.info(`saves em: ${config.savesDir}`);
  if (config.sourceMode !== 'udisks') app.log.info(`pastas observadas: ${config.slotDirs.join(', ')}`);

  const shutdown = async () => {
    for (const source of sources) await source.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('Falha ao iniciar o Playzin:', err);
  process.exit(1);
});
