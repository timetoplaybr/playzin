import { WifiBackend, WifiError, type RawNetwork, type RawWifi } from './types.js';

/**
 * Wi-Fi de verdade, para o Raspberry Pi OS (Bookworm em diante usa o NetworkManager), via D-Bus.
 *
 * - Lista as redes por perto (access points) e as redes salvas (conexões do tipo Wi-Fi).
 * - Conectar numa rede salva: ActivateConnection. Rede nova (ou senha nova):
 *   AddAndActivateConnection com a senha; se a senha estiver errada, a conexão criada é apagada.
 * - Precisa de permissão no polkit para o usuário do daemon (scripts/pi/files/50-playzin-network.rules).
 */

const NM = 'org.freedesktop.NetworkManager';
const NM_PATH = '/org/freedesktop/NetworkManager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const DEVICE = 'org.freedesktop.NetworkManager.Device';
const WIRELESS = 'org.freedesktop.NetworkManager.Device.Wireless';
const ACCESS_POINT = 'org.freedesktop.NetworkManager.AccessPoint';
const ACTIVE = 'org.freedesktop.NetworkManager.Connection.Active';
const IP4 = 'org.freedesktop.NetworkManager.IP4Config';
const SETTINGS_PATH = '/org/freedesktop/NetworkManager/Settings';
const SETTINGS = 'org.freedesktop.NetworkManager.Settings';
const CONNECTION = 'org.freedesktop.NetworkManager.Settings.Connection';

const DEVICE_TYPE_WIFI = 2;
const DEVICE_STATE_ACTIVATED = 100;
const ACTIVE_STATE_ACTIVATED = 2;
const ACTIVE_STATE_DEACTIVATED = 4;
const CONNECT_TIMEOUT_MS = 30_000;
/** Motivos de falha do NetworkManager que, na prática, querem dizer "senha errada". */
const WRONG_PASSWORD_REASONS = new Set([7, 8, 9, 10, 11]);
/** Flags de segurança do access point: PSK, SAE (WPA3) e 802.1X (empresarial). */
const KEY_MGMT_SAE = 0x400;

// dbus-next é carregado sob demanda (só existe/funciona no Linux), então tipamos de forma solta.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Dbus = any;

interface Ap {
  path: string;
  ssid: string;
  signal: number;
  secured: boolean;
  sae: boolean;
}

export class NetworkManagerBackend extends WifiBackend {
  readonly name = 'networkmanager' as const;
  private dbus: Dbus;
  private bus: any;
  private devicePath = '';
  private aps: Ap[] = [];
  private known = new Map<string, string[]>(); // ssid → caminhos das conexões salvas
  private current: RawWifi['current'] = null;
  private scanning = false;
  private refreshTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private unsubscribers: (() => void)[] = [];

  /** Testa se o NetworkManager está rodando e há uma interface Wi-Fi. */
  static async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    let bus: any;
    try {
      const mod: Dbus = await import('dbus-next');
      const dbus = mod.default ?? mod;
      bus = dbus.systemBus();
      bus.on('error', () => undefined);
      const nm = (await withTimeout(bus.getProxyObject(NM, NM_PATH), 2000)) as any;
      const devices: string[] = await withTimeout(nm.getInterface(NM).GetDevices(), 2000);
      for (const path of devices) {
        const props = (await bus.getProxyObject(NM, path)).getInterface(PROPERTIES);
        if ((await props.Get(DEVICE, 'DeviceType')).value === DEVICE_TYPE_WIFI) return true;
      }
      return false;
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

    const devices = (await this.call(NM_PATH, NM, 'GetDevices'))[0] as string[];
    for (const path of devices) {
      if ((await this.prop(path, DEVICE, 'DeviceType')) === DEVICE_TYPE_WIFI) {
        this.devicePath = path;
        break;
      }
    }
    if (!this.devicePath) throw new Error('nenhuma interface Wi-Fi encontrada');

    // Avisos do NetworkManager: redes que aparecem/somem, mudanças de estado, redes salvas.
    const deviceObj = await this.bus.getProxyObject(NM, this.devicePath);
    const wireless = deviceObj.getInterface(WIRELESS);
    const deviceProps = deviceObj.getInterface(PROPERTIES);
    const settings = (await this.bus.getProxyObject(NM, SETTINGS_PATH)).getInterface(SETTINGS);
    const onChange = () => this.scheduleRefresh();
    wireless.on('AccessPointAdded', onChange);
    wireless.on('AccessPointRemoved', onChange);
    deviceProps.on('PropertiesChanged', onChange);
    settings.on('NewConnection', onChange);
    settings.on('ConnectionRemoved', onChange);
    this.unsubscribers.push(() => {
      wireless.removeListener('AccessPointAdded', onChange);
      wireless.removeListener('AccessPointRemoved', onChange);
      deviceProps.removeListener('PropertiesChanged', onChange);
      settings.removeListener('NewConnection', onChange);
      settings.removeListener('ConnectionRemoved', onChange);
    });

    await this.refresh();
    // A força do sinal muda sem aviso: relê a cada 20 s (para o ícone da barra superior).
    this.pollTimer = setInterval(() => this.scheduleRefresh(), 20_000);
  }

  async stop(): Promise<void> {
    clearTimeout(this.refreshTimer);
    clearInterval(this.pollTimer);
    for (const off of this.unsubscribers) off();
    this.bus?.disconnect();
  }

  snapshot(): RawWifi {
    const networks: RawNetwork[] = this.aps.map(({ ssid, signal, secured }) => ({ ssid, signal, secured }));
    return { networks, known: [...this.known.keys()], current: this.current, scanning: this.scanning };
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.emit('changed');
    try {
      await this.call(this.devicePath, WIRELESS, 'RequestScan', 'a{sv}', [{}]);
    } catch {
      /* "não pode procurar logo depois de outra busca": usa a lista que já existe */
    }
    // O NetworkManager não avisa o fim da busca de forma simples: espera um pouco e atualiza.
    await sleep(3500);
    this.scanning = false;
    await this.refresh();
  }

  async connect(ssid: string, password?: string): Promise<void> {
    const ap = this.aps.filter((a) => a.ssid === ssid).sort((a, b) => b.signal - a.signal)[0];
    if (!ap) throw new WifiError(`A rede “${ssid}” não está mais por perto. Procure de novo.`);
    const saved = this.known.get(ssid) ?? [];

    let activePath: string;
    let created: string | null = null;
    try {
      if (password === undefined && saved.length > 0) {
        [activePath] = await this.call(NM_PATH, NM, 'ActivateConnection', 'ooo', [saved[0], this.devicePath, '/']);
      } else {
        if (ap.secured && password === undefined) throw new WifiError(`A rede “${ssid}” precisa de senha.`, true);
        // Senha nova para uma rede salva: substitui a conexão antiga.
        for (const path of saved) await this.call(path, CONNECTION, 'Delete').catch(() => undefined);
        const settings: Record<string, Record<string, unknown>> = {};
        if (ap.secured) {
          settings['802-11-wireless-security'] = {
            'key-mgmt': new this.dbus.Variant('s', ap.sae ? 'sae' : 'wpa-psk'),
            psk: new this.dbus.Variant('s', password),
          };
        }
        const [connPath, active] = await this.call(NM_PATH, NM, 'AddAndActivateConnection', 'a{sa{sv}}oo', [
          settings,
          this.devicePath,
          ap.path,
        ]);
        created = connPath;
        activePath = active;
      }
    } catch (err) {
      if (err instanceof WifiError) throw err;
      throw translate(err, ssid);
    }

    try {
      await this.waitActivated(activePath);
    } catch (err) {
      // Senha errada: não deixa a conexão salva com a senha ruim.
      if (created) await this.call(created, CONNECTION, 'Delete').catch(() => undefined);
      throw err instanceof WifiError ? err : translate(err, ssid);
    } finally {
      this.scheduleRefresh();
    }
  }

  async forget(ssid: string): Promise<void> {
    const saved = this.known.get(ssid) ?? [];
    for (const path of saved) {
      try {
        await this.call(path, CONNECTION, 'Delete');
      } catch (err) {
        throw translate(err, ssid);
      }
    }
    this.scheduleRefresh();
  }

  // ---------------------------------------------------------------- internos

  private async waitActivated(activePath: string): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      let state: number;
      try {
        state = (await this.prop(activePath, ACTIVE, 'State')) as number;
      } catch {
        state = ACTIVE_STATE_DEACTIVATED; // a conexão ativa sumiu: falhou
      }
      if (state === ACTIVE_STATE_ACTIVATED) return;
      if (state === ACTIVE_STATE_DEACTIVATED) {
        const reason = await this.prop(this.devicePath, DEVICE, 'StateReason').catch(() => [0, 0]);
        const code = Array.isArray(reason) ? Number(reason[1]) : 0;
        if (WRONG_PASSWORD_REASONS.has(code)) throw new WifiError('Senha incorreta.', true);
        throw new WifiError('Não consegui conectar. Confira se a rede está funcionando e tente de novo.');
      }
    }
    throw new WifiError('Demorou demais para conectar. Tente de novo mais perto do roteador.');
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh().catch((e) => this.emit('error', e as Error)), 300);
  }

  /** Relê tudo do NetworkManager: redes por perto, redes salvas e a conexão atual. */
  private async refresh(): Promise<void> {
    const apPaths = (await this.call(this.devicePath, WIRELESS, 'GetAllAccessPoints'))[0] as string[];
    const aps: Ap[] = [];
    for (const path of apPaths) {
      try {
        const p = await this.getAll(path, ACCESS_POINT);
        const ssid = Buffer.from(p.Ssid ?? []).toString('utf8');
        if (!ssid) continue; // redes ocultas
        const rsn = Number(p.RsnFlags ?? 0);
        const wpa = Number(p.WpaFlags ?? 0);
        aps.push({
          path,
          ssid,
          signal: Number(p.Strength ?? 0),
          secured: (Number(p.Flags ?? 0) & 0x1) !== 0 || rsn !== 0 || wpa !== 0,
          sae: (rsn & KEY_MGMT_SAE) !== 0 && (rsn & 0x100) === 0,
        });
      } catch {
        /* a rede sumiu no meio da leitura */
      }
    }
    this.aps = aps;

    const known = new Map<string, string[]>();
    const connections = (await this.call(SETTINGS_PATH, SETTINGS, 'ListConnections'))[0] as string[];
    for (const path of connections) {
      try {
        const [settings] = await this.call(path, CONNECTION, 'GetSettings');
        if (settings?.connection?.type?.value !== '802-11-wireless') continue;
        const ssid = Buffer.from(settings['802-11-wireless']?.ssid?.value ?? []).toString('utf8');
        if (ssid) known.set(ssid, [...(known.get(ssid) ?? []), path]);
      } catch {
        /* conexão sem permissão de leitura: ignora */
      }
    }
    this.known = known;

    this.current = null;
    const state = (await this.prop(this.devicePath, DEVICE, 'State')) as number;
    const activeAp = (await this.prop(this.devicePath, WIRELESS, 'ActiveAccessPoint')) as string;
    if (state === DEVICE_STATE_ACTIVATED && activeAp && activeAp !== '/') {
      const ap = aps.find((a) => a.path === activeAp);
      let ip: string | null = null;
      try {
        const ip4 = (await this.prop(this.devicePath, DEVICE, 'Ip4Config')) as string;
        if (ip4 && ip4 !== '/') {
          const data = (await this.getAll(ip4, IP4)).AddressData as { address?: { value: string } }[] | undefined;
          ip = data?.[0]?.address?.value ?? null;
        }
      } catch {
        /* sem IP ainda */
      }
      if (ap) this.current = { ssid: ap.ssid, signal: ap.signal, ip };
    }
    this.emit('changed');
  }

  /** Chamada D-Bus direta (sem introspecção: bem mais rápido para dezenas de redes). */
  private async call(path: string, iface: string, member: string, signature = '', body: unknown[] = []): Promise<any[]> {
    const message = new this.dbus.Message({ destination: NM, path, interface: iface, member, signature, body });
    const reply = await this.bus.call(message);
    return (reply?.body ?? []).map(unwrap);
  }

  private async prop(path: string, iface: string, name: string): Promise<any> {
    const [value] = await this.call(path, PROPERTIES, 'Get', 'ss', [iface, name]);
    return value;
  }

  private async getAll(path: string, iface: string): Promise<Record<string, any>> {
    const [map] = await this.call(path, PROPERTIES, 'GetAll', 's', [iface]);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries((map ?? {}) as Record<string, any>)) out[k] = unwrap(v);
    return out;
  }
}

/** Variant → valor (só o nível de cima; GetSettings continua com Variants dentro). */
function unwrap(v: any): any {
  return v && typeof v === 'object' && 'signature' in v && 'value' in v ? v.value : v;
}

function translate(err: unknown, ssid: string): WifiError {
  const text = `${(err as { type?: string })?.type ?? ''} ${(err as Error)?.message ?? err}`;
  if (/NotAuthorized|PermissionDenied|AccessDenied|not authorized/i.test(text)) {
    return new WifiError('O console não tem permissão para mudar o Wi-Fi (veja o README).');
  }
  if (/secrets|psk|invalid.*key|property is invalid/i.test(text)) {
    return new WifiError('Senha inválida: redes WPA usam de 8 a 63 caracteres.', true);
  }
  return new WifiError(`Não consegui conectar em “${ssid}”: ${(err as Error)?.message ?? text}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
