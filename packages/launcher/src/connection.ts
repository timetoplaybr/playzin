import { WS_PATH, type ClientMessage, type ServerMessage } from '@playzin/shared';

type Listener = (msg: ServerMessage) => void;
type StatusListener = (connected: boolean) => void;

/**
 * Conexão com o daemon. Reconecta sozinha (o daemon pode reiniciar a qualquer
 * momento, e o launcher precisa sobreviver a isso sem ninguém mexer).
 */
export class DaemonConnection {
  private socket: WebSocket | undefined;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private retryMs = 500;
  private pingTimer: number | undefined;

  connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}${WS_PATH}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryMs = 500;
      this.send({ type: 'hello', client: 'launcher' });
      this.statusListeners.forEach((l) => l(true));
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 15000);
    });

    socket.addEventListener('message', (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(msg));
    });

    socket.addEventListener('close', () => {
      window.clearInterval(this.pingTimer);
      this.statusListeners.forEach((l) => l(false));
      window.setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}
