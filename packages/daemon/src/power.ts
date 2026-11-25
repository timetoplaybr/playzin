import { EventEmitter } from 'node:events';
import type { PowerAction, PowerState } from '@playzin/shared';

/**
 * Desligar e reiniciar o console pela tela.
 *
 * - logind (Raspberry Pi): PowerOff/Reboot do systemd-logind via D-Bus. O usuário do daemon
 *   precisa de permissão no polkit (scripts/pi/files/50-playzin-power.rules).
 * - mock (PC de desenvolvimento): só avisa o launcher, que mostra um desligamento de mentira.
 *   Ninguém quer desligar o próprio computador testando a tela.
 *
 * Antes de desligar, o daemon avisa o launcher e espera um pouco: a tela mostra
 * "Desligando…" e o que estiver pendente (tempo de jogo, saves) chega ao disco.
 */

const LOGIN1 = 'org.freedesktop.login1';
const LOGIN1_PATH = '/org/freedesktop/login1';
const MANAGER = 'org.freedesktop.login1.Manager';
/** Tempo entre o aviso na tela e o desligamento de verdade. */
const GRACE_MS = 1500;

export class PowerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface PowerBackend {
  readonly name: 'logind' | 'mock';
  run(action: PowerAction): Promise<void>;
}

// dbus-next é carregado sob demanda (só existe/funciona no Linux), então tipamos de forma solta.
/* eslint-disable @typescript-eslint/no-explicit-any */

export class LogindBackend implements PowerBackend {
  readonly name = 'logind' as const;

  /** systemd-logind está respondendo no barramento do sistema? */
  static async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    let bus: any;
    try {
      const mod: any = await import('dbus-next');
      bus = (mod.default ?? mod).systemBus();
      bus.on('error', () => undefined);
      await withTimeout(bus.getProxyObject(LOGIN1, LOGIN1_PATH), 2000);
      return true;
    } catch {
      return false;
    } finally {
      bus?.disconnect?.();
    }
  }

  async run(action: PowerAction): Promise<void> {
    const mod: any = await import('dbus-next');
    const bus = (mod.default ?? mod).systemBus();
    bus.on('error', () => undefined);
    try {
      const manager = (await withTimeout(bus.getProxyObject(LOGIN1, LOGIN1_PATH), 5000)).getInterface(MANAGER);
      // false = não interativo: sem permissão no polkit, falha na hora em vez de pedir senha.
      // Com limite de tempo: um D-Bus travado não pode deixar o console "desligando" para sempre.
      await withTimeout(action === 'reboot' ? manager.Reboot(false) : manager.PowerOff(false), 10_000);
    } catch (err) {
      const raw = (err as Error).message ?? String(err);
      const text = raw === 'timeout' ? 'o sistema não respondeu' : raw;
      if (/not authorized|access denied|interactive authentication/i.test(text)) {
        throw new PowerError('O console não tem permissão para desligar (falta a regra do polkit; rode o setup de novo)', 500);
      }
      throw new PowerError(`Não foi possível ${action === 'reboot' ? 'reiniciar' : 'desligar'}: ${text}`, 500);
    } finally {
      bus.disconnect?.();
    }
  }
}

export class MockPowerBackend implements PowerBackend {
  readonly name = 'mock' as const;

  async run(): Promise<void> {
    /* simulado: quem "desliga" é o launcher, mostrando a tela apagada */
  }
}

export interface PowerControllerEvents {
  action: [action: PowerAction, simulated: boolean];
  error: [message: string];
}

export class PowerController extends EventEmitter<PowerControllerEvents> {
  private busy = false;

  constructor(
    private readonly backend: PowerBackend | null,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
    private readonly graceMs = GRACE_MS,
  ) {
    super();
  }

  state(): PowerState {
    return { backend: this.backend?.name ?? 'none' };
  }

  /** Avisa a tela, espera um pouco e desliga/reinicia. Resolve assim que o pedido foi aceito. */
  request(action: unknown): void {
    if (action !== 'poweroff' && action !== 'reboot') throw new PowerError('"action" precisa ser "poweroff" ou "reboot"');
    if (!this.backend) throw new PowerError('Este console não sabe se desligar sozinho', 501);
    if (this.busy) throw new PowerError('O console já está desligando', 409);
    const backend = this.backend;
    this.busy = true;
    const simulated = backend.name === 'mock';
    this.log.info(`[energia] ${action === 'reboot' ? 'reiniciando' : 'desligando'}${simulated ? ' (simulado)' : ''}`);
    this.emit('action', action, simulated);
    setTimeout(() => {
      backend.run(action).then(
        // No de verdade, o sistema já está desligando: fica "ocupado" até o fim.
        // No simulado, o "console" continua ligado e pode desligar de novo.
        () => {
          if (simulated) this.busy = false;
        },
        (err: Error) => {
          this.busy = false;
          this.log.warn(`[energia] ${err.message}`);
          this.emit('error', err.message);
        },
      );
    }, this.graceMs);
  }
}

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
