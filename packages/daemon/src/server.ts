import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { CARTRIDGE_URL_PREFIX, WS_PATH, type ClientMessage, type ServerMessage } from '@playzin/shared';
import type { CartridgeManager } from './cartridge-manager.js';
import type { DaemonConfig } from './config.js';
import { buildSaveShim, injectIntoHtml, type SaveMode } from './save-shim.js';
import { isSaveData, MAX_SAVE_BYTES, type SaveStore } from './save-store.js';

export async function createServer(
  config: DaemonConfig,
  manager: CartridgeManager,
  saves: SaveStore,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.PLAYZIN_LOG_LEVEL ?? 'info' } });

  await app.register(fastifyWebsocket);

  // ---- Launcher (a "BIOS" do console) ----
  const hasLauncher = fs.existsSync(config.launcherDir);
  if (hasLauncher) {
    await app.register(fastifyStatic, { root: config.launcherDir, prefix: '/', index: ['index.html'] });
  } else {
    // Ainda registramos o plugin (para reply.sendFile) mas sem rotas automáticas.
    await app.register(fastifyStatic, { root: config.launcherDir, serve: false });
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          `<h1>Playzin</h1><p>Launcher não encontrado em <code>${config.launcherDir}</code>.</p>` +
            '<p>Rode <code>npm run build</code> na raiz do projeto.</p>',
        ),
    );
  }

  // ---- Arquivos do cartucho ativo ----
  app.get<{ Params: { slotId: string; '*': string } }>(`${CARTRIDGE_URL_PREFIX}/:slotId/*`, async (req, reply) => {
    const { slotId } = req.params;
    const relative = req.params['*'] || 'index.html';
    const root = manager.activeRoot(slotId);
    if (!root || !manager.resolveFile(slotId, relative)) {
      return reply.code(404).send({ error: 'Cartucho não está inserido ou arquivo inválido' });
    }
    // Nada de cache: o mesmo endereço pode ser outro cartucho amanhã.
    reply.header('Cache-Control', 'no-store');

    // HTML de entrada: injeta o script que restaura e espelha os saves deste jogo.
    const manifest = manager.manifestForSlot(slotId);
    if (manifest && /\.html?$/i.test(manifest.entry) && samePath(relative, manifest.entry)) {
      const html = await fs.promises.readFile(manager.resolveFile(slotId, relative)!, 'utf8');
      let initial = await saves.read(manifest.id).catch(() => null);
      let mode: SaveMode = 'own';
      if (initial === null) {
        const legacy = await saves.readLegacy();
        if (legacy === undefined) mode = 'first';
        else {
          mode = 'legacy';
          initial = legacy;
        }
      }
      const script = buildSaveShim({ slotId, gameId: manifest.id, initial, mode });
      return reply.type('text/html; charset=utf-8').send(injectIntoHtml(html, script));
    }
    return reply.sendFile(relative, root, { cacheControl: false });
  });

  // ---- Saves: o jogo (via script injetado) e o launcher gravam aqui ----
  // Endereço por slot: um jogo só consegue gravar os próprios dados.
  // O jogo e o launcher podem gravar quase ao mesmo tempo ao fechar: vale a mais recente.
  const lastWriteAt = new Map<string, number>();
  app.put<{ Params: { slotId: string }; Body: { data?: unknown; at?: unknown } }>(
    `${CARTRIDGE_URL_PREFIX}/:slotId/__playzin/save`,
    { bodyLimit: MAX_SAVE_BYTES + 1024 },
    async (req, reply) => {
      const manifest = manager.manifestForSlot(req.params.slotId);
      if (!manifest) return reply.code(404).send({ error: 'slot desconhecido' });
      const data = req.body?.data;
      if (!isSaveData(data)) return reply.code(400).send({ error: 'data precisa ser um objeto de textos' });
      const at = typeof req.body?.at === 'number' ? req.body.at : Date.now();
      if (at < (lastWriteAt.get(manifest.id) ?? 0)) return reply.code(204).send(); // chegou atrasada
      lastWriteAt.set(manifest.id, at);
      try {
        await saves.write(manifest.id, { name: manifest.name, gameVersion: manifest.version }, data);
      } catch (err) {
        req.log.warn(`save de ${manifest.id} recusado: ${(err as Error).message}`);
        return reply.code(413).send({ error: (err as Error).message });
      }
      return reply.code(204).send();
    },
  );

  // Captura única dos dados que já estavam no navegador (migração de versões antigas).
  app.put<{ Params: { slotId: string }; Body: { data?: unknown } }>(
    `${CARTRIDGE_URL_PREFIX}/:slotId/__playzin/legacy`,
    { bodyLimit: MAX_SAVE_BYTES + 1024 },
    async (req, reply) => {
      if (!manager.manifestForSlot(req.params.slotId)) return reply.code(404).send({ error: 'slot desconhecido' });
      const data = req.body?.data;
      if (!isSaveData(data)) return reply.code(400).send({ error: 'data precisa ser um objeto de textos' });
      try {
        await saves.writeLegacyOnce(data);
      } catch (err) {
        return reply.code(413).send({ error: (err as Error).message });
      }
      return reply.code(204).send();
    },
  );

  app.get('/api/saves', async () => ({ saves: await saves.list() }));
  app.delete<{ Params: { id: string } }>('/api/saves/:id', async (req, reply) => {
    try {
      const cleared = await saves.clear(req.params.id);
      lastWriteAt.set(req.params.id, Date.now());
      return cleared ? reply.code(204).send() : reply.code(404).send({ error: 'nenhum progresso salvo' });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---- API de estado ----
  app.get('/api/state', async () => ({ cartridge: manager.current }));
  app.get('/api/health', async () => ({ ok: true }));

  // ---- WebSocket: avisa o launcher em tempo real ----
  app.get(WS_PATH, { websocket: true }, (socket) => {
    send(socket, { type: 'state', cartridge: manager.current });
    socket.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello' || msg.type === 'ping') send(socket, { type: 'state', cartridge: manager.current });
    });
  });

  const broadcast = (msg: ServerMessage) => {
    for (const client of app.websocketServer.clients) send(client, msg);
  };
  manager.on('inserted', (cartridge) => broadcast({ type: 'cartridge-inserted', cartridge }));
  manager.on('removed', (slotId) => broadcast({ type: 'cartridge-removed', slotId }));
  manager.on('error', (message, source) => broadcast({ type: 'cartridge-error', message, source }));

  return app;
}

function samePath(a: string, b: string): boolean {
  return path.posix.normalize(a.replace(/\\/g, '/')) === path.posix.normalize(b.replace(/\\/g, '/'));
}

function send(socket: { readyState: number; send: (data: string) => void }, msg: ServerMessage): void {
  if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(msg));
}
