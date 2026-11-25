import { readHidBatteries, type HidBattery } from './battery-sysfs.js';
import { BluetoothBackend, BluetoothError, guessKind, type RawDevice } from './types.js';

/**
 * Bluetooth de verdade, para o Raspberry Pi (ou qualquer Linux com BlueZ), via D-Bus.
 *
 * - Registra um "agente" sem PIN (NoInputNoOutput): controles pareiam no modo "Just Works",
 *   sem ninguém precisar digitar nada.
 * - Parear = Pair() + Trusted=true (para reconectar sozinho ao ligar o controle) + Connect().
 * - Bateria: org.bluez.Battery1 (controles BLE) ou, se não houver, a do kernel
 *   (/sys/class/power_supply: DualSense, xpadneo...), lida a cada 30 s.
 * - Precisa do serviço bluetooth rodando e de o usuário do daemon estar no grupo "bluetooth"
 *   (o scripts/pi/setup.sh já cuida disso).
 */

const BLUEZ = 'org.bluez';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const ADAPTER = 'org.bluez.Adapter1';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';
const BATTERY_POLL_MS = 30_000;
const AGENT_MANAGER = 'org.bluez.AgentManager1';
const AGENT_PATH = '/playzin/agent';
const PAIR_TIMEOUT_MS = 40_000;

// dbus-next é carregado sob demanda (só existe/funciona no Linux), então tipamos de forma solta.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Dbus = any;
type VariantMap = Record<string, { value: any }>;

interface DeviceEntry {
  path: string;
  props: Record<string, any>;
  /** Percentage do org.bluez.Battery1, quando o aparelho tem. */
  battery?: number;
  unsubscribe?: () => void;
}

export class BluezBackend extends BluetoothBackend {
  readonly name = 'bluez' as const;
  private dbus: Dbus;
  private bus: any;
  private adapterPath = '';
  private adapter: any;
  private adapterProps: any;
  private discovering = false;
  private entries = new Map<string, DeviceEntry>(); // por caminho D-Bus
  private hidBatteries = new Map<string, HidBattery>(); // por endereço
  private batteryTimer: NodeJS.Timeout | undefined;
  private batterySoon: NodeJS.Timeout | undefined;

  /** Testa se há um adaptador Bluetooth acessível pelo BlueZ. */
  static async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    let bus: any;
    try {
      const mod: Dbus = await import('dbus-next');
      const dbus = mod.default ?? mod;
      bus = dbus.systemBus();
      bus.on('error', () => undefined);
      const root = await withTimeout(bus.getProxyObject(BLUEZ, '/'), 2000);
      const objects = await withTimeout((root as any).getInterface(OBJECT_MANAGER).GetManagedObjects(), 2000);
      return Object.values(objects as Record<string, Record<string, unknown>>).some((ifaces) => ADAPTER in ifaces);
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

    const root = await this.bus.getProxyObject(BLUEZ, '/');
    const om = root.getInterface(OBJECT_MANAGER);
    const objects: Record<string, Record<string, VariantMap>> = await om.GetManagedObjects();

    // Adaptador: o primeiro (normalmente /org/bluez/hci0).
    const adapterPath = Object.keys(objects)
      .filter((p) => ADAPTER in objects[p])
      .sort()[0];
    if (!adapterPath) throw new Error('nenhum adaptador Bluetooth encontrado');
    this.adapterPath = adapterPath;
    const adapterObj = await this.bus.getProxyObject(BLUEZ, adapterPath);
    this.adapter = adapterObj.getInterface(ADAPTER);
    this.adapterProps = adapterObj.getInterface(PROPERTIES);
    this.discovering = Boolean(objects[adapterPath][ADAPTER].Discovering?.value);
    this.adapterProps.on('PropertiesChanged', (iface: string, changed: VariantMap) => {
      if (iface === ADAPTER && 'Discovering' in changed) {
        this.discovering = Boolean(changed.Discovering.value);
        this.emit('changed');
      }
    });

    // Liga o Bluetooth, se estiver desligado.
    try {
      await this.adapterProps.Set(ADAPTER, 'Powered', new this.dbus.Variant('b', true));
    } catch (err) {
      this.emit('error', new Error(`não consegui ligar o Bluetooth: ${(err as Error).message}`));
    }

    await this.registerAgent();

    for (const [path, ifaces] of Object.entries(objects)) {
      if (DEVICE in ifaces && path.startsWith(adapterPath + '/')) await this.addDevice(path, ifaces[DEVICE], ifaces[BATTERY]);
    }
    om.on('InterfacesAdded', (path: string, ifaces: Record<string, VariantMap>) => {
      if (!path.startsWith(this.adapterPath + '/')) return;
      if (DEVICE in ifaces) void this.addDevice(path, ifaces[DEVICE], ifaces[BATTERY]);
      // A bateria costuma aparecer só depois que o controle conecta.
      else if (BATTERY in ifaces) this.setBattery(path, ifaces[BATTERY].Percentage?.value);
    });
    om.on('InterfacesRemoved', (path: string, names: string[]) => {
      if (names.includes(DEVICE)) this.removeDevice(path);
      else if (names.includes(BATTERY)) this.setBattery(path, undefined);
    });
    await this.refreshHidBatteries();
    this.batteryTimer = setInterval(() => void this.refreshHidBatteries(), BATTERY_POLL_MS);
    this.emit('changed');
  }

  async stop(): Promise<void> {
    clearInterval(this.batteryTimer);
    clearTimeout(this.batterySoon);
    try {
      if (this.discovering) await this.adapter?.StopDiscovery();
    } catch {
      /* ignorar */
    }
    for (const e of this.entries.values()) e.unsubscribe?.();
    this.bus?.disconnect();
  }

  devices(): RawDevice[] {
    return [...this.entries.values()].map(({ props, battery }) => {
      const address = String(props.Address ?? '');
      const name = String(props.Alias ?? props.Name ?? address);
      const connected = Boolean(props.Connected);
      const hid = this.hidBatteries.get(address.toUpperCase());
      return {
        battery: connected ? (battery ?? hid?.percent ?? null) : null,
        charging: connected && Boolean(hid?.charging),
        address,
        name,
        kind: guessKind({ icon: props.Icon, cls: props.Class, appearance: props.Appearance, name: props.Name ?? props.Alias }),
        paired: Boolean(props.Paired),
        connected: Boolean(props.Connected),
      };
    });
  }

  isScanning(): boolean {
    return this.discovering;
  }

  async startScan(): Promise<void> {
    if (this.discovering) return;
    try {
      await this.adapter.SetDiscoveryFilter({ Transport: new this.dbus.Variant('s', 'auto') });
    } catch {
      /* versões antigas do BlueZ: segue sem filtro */
    }
    try {
      await this.adapter.StartDiscovery();
    } catch (err) {
      if (!/InProgress/i.test(errorName(err))) throw translate(err, 'procurar aparelhos');
    }
  }

  async stopScan(): Promise<void> {
    if (!this.discovering) return;
    try {
      await this.adapter.StopDiscovery();
    } catch {
      /* já tinha parado */
    }
  }

  async pair(address: string): Promise<void> {
    const entry = this.find(address);
    if (!entry) throw new BluetoothError('Esse aparelho não está mais por perto. Procure de novo.');
    const obj = await this.bus.getProxyObject(BLUEZ, entry.path);
    const device = obj.getInterface(DEVICE);
    const props = obj.getInterface(PROPERTIES);
    const name = String(entry.props.Alias ?? entry.props.Name ?? address);

    // Parear com a busca ligada costuma falhar em alguns adaptadores: pausa durante o pareamento.
    await this.stopScan();
    try {
      if (!entry.props.Paired) await withTimeout(device.Pair(), PAIR_TIMEOUT_MS);
    } catch (err) {
      if (!/AlreadyExists/i.test(errorName(err))) {
        await device.CancelPairing().catch(() => undefined); // não deixa um pareamento pendurado
        throw translate(err, `parear ${name}`);
      }
    }
    try {
      await props.Set(DEVICE, 'Trusted', new this.dbus.Variant('b', true));
    } catch (err) {
      this.emit('error', new Error(`não consegui marcar ${name} como confiável: ${(err as Error).message}`));
    }
    try {
      if (!entry.props.Connected) await withTimeout(device.Connect(), PAIR_TIMEOUT_MS);
    } catch (err) {
      if (!/AlreadyConnected|InProgress/i.test(errorName(err))) throw translate(err, `conectar ${name}`);
    }
  }

  async forget(address: string): Promise<void> {
    const entry = this.find(address);
    if (!entry) return;
    try {
      await this.adapter.RemoveDevice(entry.path);
    } catch (err) {
      throw translate(err, 'esquecer o aparelho');
    }
  }

  // ---------------------------------------------------------------- internos

  private find(address: string): DeviceEntry | undefined {
    const wanted = address.toUpperCase();
    for (const e of this.entries.values()) if (String(e.props.Address).toUpperCase() === wanted) return e;
    return undefined;
  }

  private async addDevice(path: string, props: VariantMap, battery?: VariantMap): Promise<void> {
    const existing = this.entries.get(path);
    const plain = unwrap(props);
    const percent = battery?.Percentage?.value;
    if (existing) {
      Object.assign(existing.props, plain);
      if (percent !== undefined) existing.battery = Number(percent);
      this.emit('changed');
      return;
    }
    const entry: DeviceEntry = { path, props: plain, battery: percent === undefined ? undefined : Number(percent) };
    this.entries.set(path, entry);
    try {
      const obj = await this.bus.getProxyObject(BLUEZ, path);
      const iface = obj.getInterface(PROPERTIES);
      const onChange = (name: string, changed: VariantMap, invalidated: string[]) => {
        if (name === BATTERY && 'Percentage' in changed) return this.setBattery(path, changed.Percentage.value);
        if (name !== DEVICE) return;
        Object.assign(entry.props, unwrap(changed));
        for (const key of invalidated ?? []) delete entry.props[key];
        // Controle acabou de ligar: a bateria do kernel aparece em seguida.
        if ('Connected' in changed) this.refreshHidBatteriesSoon();
        this.emit('changed');
      };
      iface.on('PropertiesChanged', onChange);
      entry.unsubscribe = () => iface.removeListener('PropertiesChanged', onChange);
    } catch {
      /* o aparelho sumiu antes de conseguirmos escutar */
    }
    this.emit('changed');
  }

  private setBattery(path: string, percent: unknown): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.battery = percent === undefined || percent === null ? undefined : Number(percent);
    this.emit('changed');
  }

  private refreshHidBatteriesSoon(): void {
    clearTimeout(this.batterySoon);
    this.batterySoon = setTimeout(() => void this.refreshHidBatteries(), 3000);
  }

  private async refreshHidBatteries(): Promise<void> {
    const next = await readHidBatteries();
    const before = JSON.stringify([...this.hidBatteries]);
    this.hidBatteries = next;
    if (JSON.stringify([...next]) !== before) this.emit('changed');
  }

  private removeDevice(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.unsubscribe?.();
    this.entries.delete(path);
    this.emit('changed');
  }

  /** Agente sem PIN: aceita o pareamento "Just Works" que os controles usam. */
  private async registerAgent(): Promise<void> {
    const { Interface } = this.dbus.interface;
    class Agent extends Interface {
      Release(): void {}
      RequestPinCode(): string {
        return '0000';
      }
      DisplayPinCode(): void {}
      RequestPasskey(): number {
        return 0;
      }
      DisplayPasskey(): void {}
      RequestConfirmation(): void {}
      RequestAuthorization(): void {}
      AuthorizeService(): void {}
      Cancel(): void {}
    }
    (Agent as any).configureMembers({
      methods: {
        Release: { inSignature: '', outSignature: '' },
        RequestPinCode: { inSignature: 'o', outSignature: 's' },
        DisplayPinCode: { inSignature: 'os', outSignature: '' },
        RequestPasskey: { inSignature: 'o', outSignature: 'u' },
        DisplayPasskey: { inSignature: 'ouq', outSignature: '' },
        RequestConfirmation: { inSignature: 'ou', outSignature: '' },
        RequestAuthorization: { inSignature: 'o', outSignature: '' },
        AuthorizeService: { inSignature: 'os', outSignature: '' },
        Cancel: { inSignature: '', outSignature: '' },
      },
    });
    try {
      this.bus.export(AGENT_PATH, new (Agent as any)('org.bluez.Agent1'));
      const manager = (await this.bus.getProxyObject(BLUEZ, '/org/bluez')).getInterface(AGENT_MANAGER);
      await manager.RegisterAgent(AGENT_PATH, 'NoInputNoOutput');
      await manager.RequestDefaultAgent(AGENT_PATH);
    } catch (err) {
      // Sem agente próprio, o BlueZ ainda pareia a maioria dos controles.
      this.emit('error', new Error(`agente de pareamento não registrado: ${(err as Error).message}`));
    }
  }
}

function unwrap(props: VariantMap): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props ?? {})) out[k] = v?.value;
  return out;
}

function errorName(err: unknown): string {
  const e = err as { type?: string; name?: string; message?: string };
  return `${e?.type ?? ''} ${e?.name ?? ''} ${e?.message ?? ''}`;
}

/** Erros do BlueZ → mensagens para a TV. */
function translate(err: unknown, action: string): BluetoothError {
  const text = errorName(err);
  if (/timeout|AuthenticationTimeout/i.test(text)) {
    return new BluetoothError(`Demorou demais para ${action}. Coloque o controle em modo de pareamento e tente de novo.`);
  }
  if (/Authentication(Failed|Canceled|Rejected)|ConnectionAttemptFailed|Page Timeout|not available|DoesNotExist/i.test(text)) {
    return new BluetoothError(`Não consegui ${action}. Coloque o controle em modo de pareamento, perto do console, e tente de novo.`);
  }
  if (/NotReady|rfkill|Blocked/i.test(text)) {
    return new BluetoothError('O Bluetooth do console está desligado ou bloqueado.');
  }
  if (/NotAuthorized|AccessDenied/i.test(text)) {
    return new BluetoothError('O console não tem permissão para usar o Bluetooth (veja o README).');
  }
  return new BluetoothError(`Não consegui ${action}: ${(err as Error)?.message ?? text}`);
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
