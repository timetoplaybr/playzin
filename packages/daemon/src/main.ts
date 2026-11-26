import fs from 'node:fs';
import { CartridgeManager } from './cartridge-manager.js';
import { loadConfig } from './config.js';
import { BluezBackend } from './bluetooth/bluez.js';
import { BluetoothController } from './bluetooth/controller.js';
import { MockBackend } from './bluetooth/mock.js';
import type { BluetoothBackend } from './bluetooth/types.js';
import { AchievementStore } from './achievements-store.js';
import { PlaytimeStore } from './playtime-store.js';
import { LogindBackend, MockPowerBackend, PowerController, type PowerBackend } from './power.js';
import { PhoneHub } from './phone/hub.js';
import { Updater } from './update/updater.js';
import { BackupManager } from './backup.js';
import { BackgroundStore } from './background-store.js';
import { REPO_ROOT } from './config.js';
import { ProfileStore } from './profile-store.js';
import { SaveStore } from './save-store.js';
import { ScreenshotStore } from './screenshot-store.js';
import { WifiController } from './wifi/controller.js';
import { MockWifiBackend } from './wifi/mock.js';
import { NetworkManagerBackend } from './wifi/networkmanager.js';
import type { WifiBackend } from './wifi/types.js';
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
  const profiles = new ProfileStore(config.profilesFile, saves);
  await profiles.init();
  const playtime = new PlaytimeStore(config.savesDir);
  const achievements = new AchievementStore(config.savesDir);
  const screenshots = new ScreenshotStore(config.screenshotsDir);

  let backend: BluetoothBackend | null = null;
  if (config.bluetooth === 'mock') backend = new MockBackend();
  else if (config.bluetooth === 'bluez' || (config.bluetooth === 'auto' && (await BluezBackend.isAvailable()))) {
    backend = new BluezBackend();
  }
  const bluetooth = new BluetoothController(backend, {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });

  let wifiBackend: WifiBackend | null = null;
  if (config.wifi === 'mock') wifiBackend = new MockWifiBackend();
  else if (config.wifi === 'networkmanager' || (config.wifi === 'auto' && (await NetworkManagerBackend.isAvailable()))) {
    wifiBackend = new NetworkManagerBackend();
  }
  const wifi = new WifiController(wifiBackend, {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });

  let powerBackend: PowerBackend | null = null;
  // INVOCATION_ID: o systemd define para os serviços. Rodando à mão (npm start), é o PC de alguém.
  const underSystemd = Boolean(process.env.INVOCATION_ID);
  if (config.power === 'mock') powerBackend = new MockPowerBackend();
  else if (config.power === 'logind') powerBackend = new LogindBackend();
  else if (config.power === 'auto') {
    powerBackend = underSystemd && (await LogindBackend.isAvailable()) ? new LogindBackend() : new MockPowerBackend();
  }
  const power = new PowerController(powerBackend, {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });

  // Versão do sistema: a do package.json da pasta que está rodando (a do pacote instalado).
  const version = (JSON.parse(fs.readFileSync(`${REPO_ROOT}/package.json`, 'utf8')) as { version?: string }).version ?? '0.0.0';
  const trialMs = Number(process.env.PLAYZIN_UPDATE_TRIAL_MS) || undefined; // só para testes
  const updater = new Updater({ ...config.update, appRoot: REPO_ROOT, trialMs }, version, {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });

  const phone = new PhoneHub(config.phone, {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });

  // Backup no pendrive: depois de restaurar, perfis, tempo de jogo, conquistas e capturas leem tudo de novo.
  const backup = new BackupManager(
    { savesDir: config.savesDir, profilesFile: config.profilesFile, screenshotsDir: config.screenshotsDir },
    version,
    [profiles, playtime, achievements, screenshots],
    { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
  );

  const backgrounds = new BackgroundStore(config.backgroundsDir, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });

  const app = await createServer(config, manager, saves, profiles, playtime, achievements, bluetooth, wifi, power, screenshots, phone, updater, backup, backgrounds);

  const sources: CartridgeSource[] = [];
  const wantUdisks =
    config.sourceMode === 'udisks' || (config.sourceMode === 'auto' && (await UdisksSource.isAvailable()));
  if (wantUdisks) sources.push(new UdisksSource());
  if (config.sourceMode !== 'udisks') {
    // Garante que a pasta de desenvolvimento exista para os scripts cart:insert/eject.
    for (const dir of config.slotDirs) {
      if (dir.endsWith('dev-slot')) fs.mkdirSync(dir, { recursive: true });
    }
    sources.push(new DirectorySource(config.slotDirs, config.pollIntervalMs, config.driveRoots));
  }

  for (const source of sources) {
    manager.attach(source);
    backup.attach(source);
    await source.start();
  }

  try {
    // No Pi, liga o pareamento automático se não houver controle conhecido. No simulado, só se pedido.
    await bluetooth.start({ autoPair: config.autoPair ?? backend?.name === 'bluez' });
  } catch (err) {
    app.log.warn(`Bluetooth indisponível: ${(err as Error).message}`);
  }

  try {
    await wifi.start();
  } catch (err) {
    app.log.warn(`Wi-Fi indisponível: ${(err as Error).message}`);
  }

  await app.listen({ host: config.host, port: config.port });
  await phone.start();
  await updater.start();
  app.log.info(`Playzin ${version} pronto em http://${config.host}:${config.port}`);
  app.log.info(`fontes de cartucho: ${sources.map((s) => s.name).join(', ')}`);
  app.log.info(`saves em: ${config.savesDir}`);
  app.log.info(`capturas em: ${config.screenshotsDir}`);
  app.log.info(`perfis: ${profiles.list().map((p) => p.name).join(', ') || 'nenhum ainda'}`);
  app.log.info(`bluetooth: ${backend ? (backend.name === 'mock' ? 'simulado' : 'BlueZ') : 'indisponível'}`);
  app.log.info(`wi-fi: ${wifiBackend ? (wifiBackend.name === 'mock' ? 'simulado' : 'NetworkManager') : 'indisponível'}`);
  app.log.info(`desligar: ${powerBackend ? (powerBackend.name === 'mock' ? 'simulado' : 'logind') : 'indisponível'}`);
  app.log.info(`atualização pelo Wi-Fi: ${updater.getState().supported ? config.update.url : (updater.getState().problem ?? 'desligada')}`);
  if (config.sourceMode !== 'udisks') {
    app.log.info(`pastas observadas: ${config.slotDirs.join(', ')}`);
    if (config.driveRoots.length) app.log.info(`unidades observadas: ${config.driveRoots.map((d) => d.slice(0, 2)).join(' ')}`);
  }

  const shutdown = async () => {
    for (const source of sources) await source.stop();
    await bluetooth.stop();
    await wifi.stop();
    await phone.stop();
    updater.stop();
    await app.close();
    process.exit(0);
  };
  // Versão nova (ou de volta para a anterior) no lugar: sai e o systemd sobe o daemon de novo, já nela.
  updater.on('restart', () => setTimeout(() => void shutdown(), 800));
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('Falha ao iniciar o Playzin:', err);
  process.exit(1);
});
