import type { BluetoothState, CartridgeInfo, PowerState, Profile, WifiState } from '@playzin/shared';

export type ConsoleStatus = 'connecting' | 'empty' | 'ready' | 'playing';

export interface ConsoleState {
  status: ConsoleStatus;
  cartridge: CartridgeInfo | null;
  /** Mensagem temporária para mostrar na tela (erro ou aviso). */
  notice: { text: string; kind: 'info' | 'error'; at: number } | null;
  /** Estado do Bluetooth do console (null até o daemon responder). */
  bluetooth: BluetoothState | null;
  /** Estado do Wi-Fi do console (null até o daemon responder). */
  wifi: WifiState | null;
  /** Como o console desliga (null até o daemon responder). */
  power: PowerState | null;
  /** Perfis do console (null até o daemon responder). */
  profiles: Profile[] | null;
  /** Quem está jogando agora (null = ninguém escolheu ainda). */
  profileId: string | null;
}

type Listener = (state: ConsoleState, previous: ConsoleState) => void;

/** Estado único do console. Cenas e o frame do jogo só reagem a ele. */
export class ConsoleStore {
  private state: ConsoleState = { status: 'connecting', cartridge: null, notice: null, bluetooth: null, wifi: null, power: null, profiles: null, profileId: null };
  private listeners = new Set<Listener>();

  get(): ConsoleState {
    return this.state;
  }

  update(patch: Partial<ConsoleState>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    this.listeners.forEach((l) => l(this.state, previous));
  }

  notify(text: string, kind: 'info' | 'error' = 'info'): void {
    this.update({ notice: { text, kind, at: Date.now() } });
  }

  /** Perfil ativo, se houver. */
  profile(): Profile | null {
    const { profiles, profileId } = this.state;
    return profiles?.find((p) => p.id === profileId) ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
