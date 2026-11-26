import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import qrcode from 'qrcode-generator';
import { PHONE_BUTTON_COUNT, PHONE_MAX, type PhonePad, type PhonePairing } from '@playzin/shared';
import { PHONE_PAGE } from './page.js';

/** O QR code vale por este tempo (ou até a tela fechar). */
const PAIRING_MS = 5 * 60_000;
/** Conexão caiu (tela apagou, Wi-Fi piscou): o celular tem este tempo para voltar como o mesmo jogador. */
const RECONNECT_GRACE_MS = 20_000;
const MAX_MESSAGE_BYTES = 512;
const ALL_BUTTONS = (1 << PHONE_BUTTON_COUNT) - 1;

interface Session {
  pad: PhonePad;
  /** Segredo guardado no celular para reconectar sem o QR (vale até o console desligar). */
  key: string;
  socket: { send(data: string): void; close(): void; readyState: number } | null;
  graceTimer?: NodeJS.Timeout;
}

export interface PhoneHubEvents {
  pads: [pads: PhonePad[]];
  pairing: [pairing: PhonePairing];
  joined: [pad: PhonePad];
  left: [pad: PhonePad];
  input: [id: string, b: number, x: number, y: number];
}

export interface PhoneHubOptions {
  enabled: boolean;
  host: string;
  port: number;
}

/**
 * Celular como controle. Um segundo servidor, aberto para a rede de casa (o principal só escuta o
 * próprio console), que serve SÓ a página do controle e a conexão dela: nada de API, saves ou
 * cartuchos. Para entrar, o celular precisa do código do QR code, que muda a cada vez que a tela
 * abre e vence em 5 minutos; depois, ele reconecta com um segredo próprio até o console desligar.
 */
export class PhoneHub extends EventEmitter<PhoneHubEvents> {
  private app: FastifyInstance | null = null;
  private sessions = new Map<string, Session>();
  private token: string | null = null;
  private expiresAt = 0;
  private expireTimer: NodeJS.Timeout | undefined;
  private listening = false;

  constructor(
    private readonly options: PhoneHubOptions,
    private readonly log: { info: (m: string) => void; warn: (m: string) => void },
  ) {
    super();
  }

  async start(): Promise<void> {
    if (!this.options.enabled) return;
    const app = Fastify({ logger: false, bodyLimit: 1024 });
    await app.register(fastifyWebsocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });
    const page = async (_req: unknown, reply: import('fastify').FastifyReply) =>
      reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(PHONE_PAGE);
    app.get('/p', page);
    app.get('/p/:token', page);
    app.get('/p/ws', { websocket: true }, (socket, req) => this.onSocket(socket, String(req.headers['user-agent'] ?? '')));
    // Qualquer outro endereço: nada aqui.
    app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Playzin: abra o QR code na TV.'));
    try {
      await app.listen({ host: this.options.host, port: this.options.port });
      this.app = app;
      this.listening = true;
      this.log.info(`[celular] controle pelo celular em http://${lanAddress() ?? this.options.host}:${this.options.port}/p`);
    } catch (err) {
      this.log.warn(`[celular] não consegui abrir a porta ${this.options.port}: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.expireTimer);
    for (const s of this.sessions.values()) clearTimeout(s.graceTimer);
    await this.app?.close();
  }

  // ---------------------------------------------------------------- pareamento (tela da TV)

  /** Abre (ou renova) o QR code. */
  openPairing(): PhonePairing {
    this.token = crypto.randomBytes(12).toString('base64url');
    this.expiresAt = Date.now() + PAIRING_MS;
    clearTimeout(this.expireTimer);
    this.expireTimer = setTimeout(() => this.closePairing(), PAIRING_MS);
    const pairing = this.pairing();
    this.emit('pairing', pairing);
    return pairing;
  }

  closePairing(): void {
    if (!this.token) return;
    this.token = null;
    clearTimeout(this.expireTimer);
    this.emit('pairing', this.pairing());
  }

  pairing(): PhonePairing {
    const closed: PhonePairing = { open: false, url: null, qrSvg: null, expiresAt: null, problem: null };
    if (!this.options.enabled) return { ...closed, problem: 'O celular como controle está desligado na configuração do console.' };
    if (!this.listening) return { ...closed, problem: `O console não conseguiu abrir a porta ${this.options.port} para os celulares.` };
    if (!this.token) return closed;
    const ip = lanAddress();
    if (!ip) return { ...closed, open: true, problem: 'O console está sem rede. Conecte-o ao Wi-Fi para usar o celular.' };
    const url = `http://${ip}:${this.options.port}/p/${this.token}`;
    return { open: true, url, qrSvg: qrSvg(url), expiresAt: new Date(this.expiresAt).toISOString(), problem: null };
  }

  pads(): PhonePad[] {
    return [...this.sessions.values()].map((s) => ({ ...s.pad })).sort((a, b) => a.slot - b.slot);
  }

  /** Desconecta um celular pela TV (ele precisa do QR de novo para voltar). */
  kick(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sendTo(session, { t: 'bye', message: 'Este celular foi desconectado pela TV.' });
    session.socket?.close();
    this.remove(session);
    return true;
  }

  rumble(id: string, ms: number): void {
    const session = this.sessions.get(id);
    if (session) this.sendTo(session, { t: 'rumble', ms: Math.max(10, Math.min(1000, Math.round(ms))) });
  }

  label(id: string, player: number | null): void {
    const session = this.sessions.get(id);
    if (session) this.sendTo(session, { t: 'label', player: player && player > 0 ? Math.floor(player) : null });
  }

  // ---------------------------------------------------------------- celulares

  private onSocket(socket: Session['socket'] & { on(ev: string, cb: (...a: unknown[]) => void): void }, userAgent: string): void {
    let session: Session | null = null;
    socket.on('message', (data: unknown) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!session) {
        if (msg.t !== 'hello') return;
        session = this.hello(socket, msg, userAgent);
        return;
      }
      if (msg.t === 's') {
        const b = Number(msg.b) & ALL_BUTTONS;
        const x = clampAxis(msg.x);
        const y = clampAxis(msg.y);
        this.emit('input', session.pad.id, b, x, y);
      }
    });
    socket.on('close', () => {
      if (!session || session.socket !== socket) return;
      session.socket = null;
      // Solta tudo na hora (nada fica "apertado" no jogo) e espera um pouco o celular voltar.
      this.emit('input', session.pad.id, 0, 0, 0);
      session.pad.connected = false;
      this.emitPads();
      const s = session;
      s.graceTimer = setTimeout(() => {
        if (!s.socket && this.sessions.get(s.pad.id) === s) {
          this.log.info(`[celular] ${s.pad.name} não voltou: desconectado`);
          this.remove(s);
        }
      }, RECONNECT_GRACE_MS);
    });
  }

  private hello(socket: Session['socket'], msg: Record<string, unknown>, userAgent: string): Session | null {
    // Volta de um celular que já estava conectado (tela apagou e acendeu): pelo segredo dele.
    if (typeof msg.key === 'string') {
      const existing = [...this.sessions.values()].find((s) => s.key === msg.key);
      if (existing) {
        clearTimeout(existing.graceTimer);
        existing.socket?.close();
        existing.socket = socket;
        existing.pad.connected = true;
        this.sendTo(existing, { t: 'welcome', id: existing.pad.id, key: existing.key, name: existing.pad.name });
        this.emitPads();
        return existing;
      }
    }
    const fail = (message: string) => {
      socket?.send(JSON.stringify({ t: 'error', message, fatal: true }));
      socket?.close();
      return null;
    };
    if (!this.token || msg.token !== this.token || Date.now() > this.expiresAt) {
      return fail('Este QR code venceu.');
    }
    const used = new Set([...this.sessions.values()].map((s) => s.pad.slot));
    const slot = [0, 1, 2, 3].find((n) => !used.has(n));
    if (slot === undefined || this.sessions.size >= PHONE_MAX) return fail(`Já há ${PHONE_MAX} celulares conectados.`);
    const pad: PhonePad = { id: `ph${crypto.randomBytes(4).toString('hex')}`, name: `${deviceName(userAgent)} ${slot + 1}`, slot, connected: true };
    const session: Session = { pad, key: crypto.randomBytes(18).toString('base64url'), socket };
    this.sessions.set(pad.id, session);
    this.sendTo(session, { t: 'welcome', id: pad.id, key: session.key, name: pad.name });
    this.log.info(`[celular] conectado: ${pad.name}`);
    this.emitPads();
    this.emit('joined', { ...pad });
    return session;
  }

  private remove(session: Session): void {
    clearTimeout(session.graceTimer);
    if (!this.sessions.delete(session.pad.id)) return;
    this.emit('input', session.pad.id, 0, 0, 0);
    this.emitPads();
    this.emit('left', { ...session.pad, connected: false });
  }

  private emitPads(): void {
    this.emit('pads', this.pads());
  }

  private sendTo(session: Session, msg: Record<string, unknown>): void {
    if (session.socket && session.socket.readyState === 1) session.socket.send(JSON.stringify(msg));
  }
}

/** Endereço do console na rede de casa (o Wi-Fi primeiro). */
export function lanAddress(): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  const score = (n: string) => (/^(wlan|wl|wi-?fi)/i.test(n) ? 0 : /^(eth|en|ethernet)/i.test(n) ? 1 : /vethernet|docker|vbox|vmnet|virtual|tailscale|zt/i.test(n) ? 3 : 2);
  candidates.sort((a, b) => score(a.name) - score(b.name));
  return candidates[0]?.address ?? null;
}

function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function deviceName(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  return 'Celular';
}

function clampAxis(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, Math.round(n * 100) / 100));
}
