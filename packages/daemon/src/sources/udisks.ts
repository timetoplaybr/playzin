import { CartridgeSource } from './types.js';

/**
 * Fonte para o Raspberry Pi: escuta o UDisks2 no D-Bus do sistema.
 *
 * Quando um pendrive USB aparece, monta o sistema de arquivos como somente leitura
 * e anuncia o ponto de montagem. Quando ele é removido, anuncia a remoção.
 * Quem decide se é um cartucho Playzin (tem playzin.json?) é o CartridgeManager.
 *
 * Requer: pacote udisks2 instalado e permissão de montagem para o usuário do
 * daemon (ver scripts/pi/files/50-playzin-udisks.rules).
 */

const UDISKS = 'org.freedesktop.UDisks2';
const UDISKS_PATH = '/org/freedesktop/UDisks2';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const IFACE_BLOCK = 'org.freedesktop.UDisks2.Block';
const IFACE_FILESYSTEM = 'org.freedesktop.UDisks2.Filesystem';
const IFACE_DRIVE = 'org.freedesktop.UDisks2.Drive';

// dbus-next é carregado sob demanda (só existe/funciona no Linux), então tipamos de forma solta.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Dbus = any;
type VariantMap = Record<string, { value: any }>;
type InterfaceMap = Record<string, VariantMap>;

export class UdisksSource extends CartridgeSource {
  readonly name = 'udisks';
  private dbus: Dbus;
  private bus: any;
  private objectManager: any;
  /** Objetos D-Bus de blocos que já anunciamos como inseridos. */
  private announced = new Set<string>();
  /** Evita montar o mesmo dispositivo duas vezes em paralelo. */
  private pending = new Set<string>();

  /** Testa se o UDisks2 está acessível nesta máquina. */
  static async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    let bus: any;
    try {
      const mod: Dbus = await import('dbus-next');
      const dbus = mod.default ?? mod;
      bus = dbus.systemBus();
      // Sem listener, um erro de conexão do dbus-next derruba o processo inteiro.
      bus.on('error', () => undefined);
      await withTimeout(bus.getProxyObject(UDISKS, UDISKS_PATH), 2000);
      return true;
    } catch {
      return false;
    } finally {
      try {
        bus?.disconnect();
      } catch {
        /* ignorar */
      }
    }
  }

  async start(): Promise<void> {
    const mod: Dbus = await import('dbus-next');
    this.dbus = mod.default ?? mod;
    this.bus = this.dbus.systemBus();
    this.bus.on('error', (err: Error) => this.emit('error', new Error(`D-Bus: ${err.message}`)));
    const root = await this.bus.getProxyObject(UDISKS, UDISKS_PATH);
    this.objectManager = root.getInterface(OBJECT_MANAGER);

    this.objectManager.on('InterfacesAdded', (objectPath: string, ifaces: InterfaceMap) => {
      if (ifaces[IFACE_FILESYSTEM]) void this.handleBlock(objectPath);
    });
    this.objectManager.on('InterfacesRemoved', (objectPath: string, names: string[]) => {
      if (names.includes(IFACE_FILESYSTEM) || names.includes(IFACE_BLOCK)) this.handleGone(objectPath);
    });

    // Pendrive que já estava plugado quando o console ligou.
    const objects: Record<string, InterfaceMap> = await this.objectManager.GetManagedObjects();
    for (const [objectPath, ifaces] of Object.entries(objects)) {
      if (ifaces[IFACE_FILESYSTEM]) await this.handleBlock(objectPath);
    }
  }

  async stop(): Promise<void> {
    this.objectManager?.removeAllListeners();
    this.bus?.disconnect();
  }

  private async handleBlock(objectPath: string): Promise<void> {
    if (this.announced.has(objectPath) || this.pending.has(objectPath)) return;
    this.pending.add(objectPath);
    try {
      const obj = await this.bus.getProxyObject(UDISKS, objectPath);
      const props = obj.getInterface(PROPERTIES);

      if (!(await this.isRemovableUsb(props))) return;

      const mountPoint = await this.mountReadOnly(obj, props);
      if (!mountPoint) return;

      this.announced.add(objectPath);
      this.emit('inserted', { key: objectPath, rootPath: mountPoint, source: this.name });
    } catch (err) {
      this.emit('error', new Error(`Falha ao preparar ${objectPath}: ${(err as Error).message}`));
    } finally {
      this.pending.delete(objectPath);
    }
  }

  private handleGone(objectPath: string): void {
    if (!this.announced.delete(objectPath)) return;
    // O UDisks2 limpa a montagem órfã sozinho quando o dispositivo some.
    this.emit('removed', objectPath);
  }

  /** Só aceitamos partições de drives USB removíveis: nunca o cartão SD do sistema. */
  private async isRemovableUsb(blockProps: any): Promise<boolean> {
    const hintSystem = (await blockProps.Get(IFACE_BLOCK, 'HintSystem')).value as boolean;
    const hintIgnore = (await blockProps.Get(IFACE_BLOCK, 'HintIgnore')).value as boolean;
    if (hintIgnore) return false;

    const drivePath = (await blockProps.Get(IFACE_BLOCK, 'Drive')).value as string;
    if (!drivePath || drivePath === '/') return false;

    const drive = await this.bus.getProxyObject(UDISKS, drivePath);
    const driveProps = drive.getInterface(PROPERTIES);
    const connectionBus = (await driveProps.Get(IFACE_DRIVE, 'ConnectionBus')).value as string;
    const removable = (await driveProps.Get(IFACE_DRIVE, 'Removable')).value as boolean;
    return connectionBus === 'usb' && (removable || !hintSystem);
  }

  private async mountReadOnly(obj: any, props: any): Promise<string | undefined> {
    const existing = decodeMountPoints((await props.Get(IFACE_FILESYSTEM, 'MountPoints')).value);
    if (existing.length > 0) return existing[0];

    const fsIface = obj.getInterface(IFACE_FILESYSTEM);
    const options = { options: new this.dbus.Variant('s', 'ro'), 'auth.no_user_interaction': new this.dbus.Variant('b', true) };
    try {
      return (await fsIface.Mount(options)) as string;
    } catch (err) {
      // Alguém montou entre a nossa leitura e o Mount: usa o ponto existente.
      const again = decodeMountPoints((await props.Get(IFACE_FILESYSTEM, 'MountPoints')).value);
      if (again.length > 0) return again[0];
      throw err;
    }
  }
}

/** MountPoints vem como lista de arrays de bytes terminados em \0. */
function decodeMountPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((bytes) => Buffer.from(bytes as Uint8Array).toString('utf8').replace(/\0+$/, ''))
    .filter(Boolean);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
