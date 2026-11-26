import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { buildGamepadRemapScript, CARTRIDGE_URL_PREFIX, SCREENSHOT_MAX_BYTES, WS_PATH, type ClientMessage, type ServerMessage } from '@playzin/shared';
import type { CartridgeManager } from './cartridge-manager.js';
import type { DaemonConfig } from './config.js';
import { buildSaveShim, injectIntoHtml, type SaveMode } from './save-shim.js';
import { isSaveData, MAX_SAVE_BYTES, type SaveData, type SaveStore } from './save-store.js';
import { ProfileError, type ProfileStore } from './profile-store.js';
import type { PlaytimeStore } from './playtime-store.js';
import { AchievementError, type AchievementStore } from './achievements-store.js';
import type { BluetoothController } from './bluetooth/controller.js';
import type { WifiController } from './wifi/controller.js';
import { WifiError } from './wifi/types.js';
import { BluetoothError } from './bluetooth/types.js';
import { PowerError, type PowerController } from './power.js';
import { ScreenshotError, type ScreenshotStore } from './screenshot-store.js';

export async function createServer(
  config: DaemonConfig,
  manager: CartridgeManager,
  saves: SaveStore,
  profiles: ProfileStore,
  playtime: PlaytimeStore,
  achievements: AchievementStore,
  bluetooth: BluetoothController,
  wifi: WifiController,
  power: PowerController,
  screenshots: ScreenshotStore,
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
  app.get<{ Params: { slotId: string; '*': string }; Querystring: { profile?: string } }>(`${CARTRIDGE_URL_PREFIX}/:slotId/*`, async (req, reply) => {
    const { slotId } = req.params;
    const relative = req.params['*'] || 'index.html';
    const root = manager.activeRoot(slotId);
    if (!root || !manager.resolveFile(slotId, relative)) {
      return reply.code(404).send({ error: 'Cartucho não está inserido ou arquivo inválido' });
    }
    // Nada de cache: o mesmo endereço pode ser outro cartucho amanhã.
    reply.header('Cache-Control', 'no-store');

    // HTML de entrada: injeta o script que restaura e espelha os saves deste jogo, do perfil
    // que está jogando (?profile=<id>, colocado pelo launcher).
    const manifest = manager.manifestForSlot(slotId);
    if (manifest && /\.html?$/i.test(manifest.entry) && samePath(relative, manifest.entry)) {
      const html = await fs.promises.readFile(manager.resolveFile(slotId, relative)!, 'utf8');
      const profile = profiles.get(req.query.profile);
      let initial: SaveData | null = {};
      let mode: SaveMode = 'own';
      if (profile) {
        initial = await saves.read(profile.id, manifest.id).catch(() => null);
        if (initial === null) {
          // Primeira vez deste jogo neste perfil. Só o primeiro perfil do console herda o que
          // estava no navegador antes; os outros começam do zero.
          const owner = profiles.ownsLegacy(profile.id);
          const legacy = await saves.readLegacy();
          mode = legacy === undefined ? 'first' : 'legacy';
          initial = owner ? (legacy ?? null) : {};
        }
      }
      const script = buildSaveShim({ slotId, gameId: manifest.id, profileId: profile?.id ?? null, initial, mode });
      // Botões remapeados em Controles valem também para jogos sem o SDK: o navigator.getGamepads()
      // do jogo já nasce trocado (antes de qualquer script do jogo).
      return reply.type('text/html; charset=utf-8').send(injectIntoHtml(html, buildGamepadRemapScript() + script));
    }
    return reply.sendFile(relative, root, { cacheControl: false });
  });

  // ---- Saves: o jogo (via script injetado) e o launcher gravam aqui ----
  // Endereço por slot: um jogo só consegue gravar os próprios dados.
  // O jogo e o launcher podem gravar quase ao mesmo tempo ao fechar: vale a mais recente.
  const lastWriteAt = new Map<string, number>();
  app.put<{ Params: { slotId: string; profileId: string }; Body: { data?: unknown; at?: unknown } }>(
    `${CARTRIDGE_URL_PREFIX}/:slotId/__playzin/save/:profileId`,
    { bodyLimit: MAX_SAVE_BYTES + 1024 },
    async (req, reply) => {
      const manifest = manager.manifestForSlot(req.params.slotId);
      if (!manifest) return reply.code(404).send({ error: 'slot desconhecido' });
      const profile = profiles.get(req.params.profileId);
      if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
      const data = req.body?.data;
      if (!isSaveData(data)) return reply.code(400).send({ error: 'data precisa ser um objeto de textos' });
      const key = `${profile.id}/${manifest.id}`;
      const at = typeof req.body?.at === 'number' ? req.body.at : Date.now();
      if (at < (lastWriteAt.get(key) ?? 0)) return reply.code(204).send(); // chegou atrasada
      lastWriteAt.set(key, at);
      try {
        await saves.write(profile.id, manifest.id, { name: manifest.name, gameVersion: manifest.version }, data);
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

  // ---- Bluetooth: tela de controles ----
  const ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
  const btFail = (reply: import('fastify').FastifyReply, err: unknown) =>
    reply.code(err instanceof BluetoothError ? 409 : 500).send({ error: (err as Error).message });

  app.get('/api/bluetooth', async () => bluetooth.state());
  app.post<{ Body: { on?: unknown } }>('/api/bluetooth/scan', async (req, reply) => {
    try {
      await bluetooth.setScan(req.body?.on !== false);
      return bluetooth.state();
    } catch (err) {
      return btFail(reply, err);
    }
  });
  app.post<{ Body: { on?: unknown } }>('/api/bluetooth/auto', async (req, reply) => {
    try {
      await bluetooth.setAutoPair(req.body?.on === true);
      return bluetooth.state();
    } catch (err) {
      return btFail(reply, err);
    }
  });
  app.post<{ Params: { address: string } }>('/api/bluetooth/devices/:address/pair', async (req, reply) => {
    if (!ADDRESS.test(req.params.address)) return reply.code(400).send({ error: 'endereço inválido' });
    try {
      bluetooth.pair(req.params.address.toUpperCase());
      return reply.code(202).send({ pairing: true });
    } catch (err) {
      return btFail(reply, err);
    }
  });
  app.delete<{ Params: { address: string } }>('/api/bluetooth/devices/:address', async (req, reply) => {
    if (!ADDRESS.test(req.params.address)) return reply.code(400).send({ error: 'endereço inválido' });
    try {
      await bluetooth.forget(req.params.address.toUpperCase());
      return reply.code(204).send();
    } catch (err) {
      return btFail(reply, err);
    }
  });

  // ---- Wi-Fi: tela de redes ----
  const wifiFail = (reply: import('fastify').FastifyReply, err: unknown) =>
    reply
      .code(err instanceof WifiError ? 409 : 500)
      .send({ error: (err as Error).message, wrongPassword: err instanceof WifiError && err.wrongPassword });

  app.get('/api/wifi', async () => wifi.state());
  app.post('/api/wifi/scan', async (_req, reply) => {
    try {
      void wifi.scan().catch((err) => app.log.warn(`[wifi] busca: ${(err as Error).message}`));
      return reply.code(202).send(wifi.state());
    } catch (err) {
      return wifiFail(reply, err);
    }
  });
  app.post<{ Body: { ssid?: unknown; password?: unknown } }>('/api/wifi/connect', async (req, reply) => {
    const { ssid, password } = req.body ?? {};
    if (typeof ssid !== 'string' || !ssid) return reply.code(400).send({ error: 'ssid obrigatório' });
    if (password !== undefined && typeof password !== 'string') return reply.code(400).send({ error: 'senha inválida' });
    try {
      wifi.connect(ssid, password);
      return reply.code(202).send({ connecting: ssid });
    } catch (err) {
      return wifiFail(reply, err);
    }
  });
  app.delete<{ Params: { ssid: string } }>('/api/wifi/networks/:ssid', async (req, reply) => {
    try {
      await wifi.forget(req.params.ssid);
      return reply.code(204).send();
    } catch (err) {
      return wifiFail(reply, err);
    }
  });

  // ---- Energia ----
  app.get('/api/power', async () => power.state());
  app.post<{ Body: { action?: unknown } }>('/api/power', async (req, reply) => {
    try {
      power.request(req.body?.action);
      return reply.code(202).send({ ok: true });
    } catch (err) {
      const status = err instanceof PowerError ? err.status : 500;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  // ---- Perfis ----
  const profileFail = (reply: import('fastify').FastifyReply, err: unknown) =>
    err instanceof ProfileError
      ? reply.code(err.status).send({ error: err.message })
      : reply.code(500).send({ error: (err as Error).message });

  app.get('/api/profiles', async () => ({ profiles: profiles.list() }));
  app.post<{ Body: { name?: unknown; icon?: unknown; color?: unknown } }>('/api/profiles', async (req, reply) => {
    try {
      return reply.code(201).send(await profiles.create(req.body ?? {}));
    } catch (err) {
      return profileFail(reply, err);
    }
  });
  app.patch<{ Params: { id: string }; Body: { name?: unknown; icon?: unknown; color?: unknown } }>(
    '/api/profiles/:id',
    async (req, reply) => {
      try {
        return await profiles.update(req.params.id, req.body ?? {});
      } catch (err) {
        return profileFail(reply, err);
      }
    },
  );
  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    try {
      await profiles.remove(req.params.id);
      playtime.forget(req.params.id);
      achievements.forget(req.params.id);
      for (const key of lastWriteAt.keys()) if (key.startsWith(`${req.params.id}/`)) lastWriteAt.delete(key);
      return reply.code(204).send();
    } catch (err) {
      return profileFail(reply, err);
    }
  });

  // ---- Tempo de jogo por perfil ----
  app.get<{ Querystring: { profile?: string } }>('/api/playtime', async (req, reply) => {
    const profile = profiles.get(req.query.profile);
    if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
    return playtime.summary(profile.id);
  });
  app.get('/api/playtime/totals', async () => ({
    totals: await playtime.totals(profiles.list().map((p) => p.id)),
  }));
  app.get<{ Params: { game: string } }>('/api/playtime/game/:game', async (req, reply) => {
    try {
      return await playtime.byGame(profiles.list().map((p) => p.id), req.params.game);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.post<{ Params: { profile: string; game: string }; Body: { seconds?: unknown; name?: unknown; session?: unknown } }>(
    '/api/playtime/:profile/:game',
    async (req, reply) => {
      const profile = profiles.get(req.params.profile);
      if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
      const { seconds, name, session } = req.body ?? {};
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || typeof session !== 'string') {
        return reply.code(400).send({ error: 'seconds (número) e session são obrigatórios' });
      }
      try {
        return await playtime.add(profile.id, req.params.game, {
          seconds,
          session,
          name: typeof name === 'string' ? name : req.params.game,
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  // ---- Conquistas por perfil ----
  const achievementFail = (reply: import('fastify').FastifyReply, err: unknown) =>
    reply.code(err instanceof AchievementError ? err.status : 500).send({ error: (err as Error).message });

  app.get<{ Querystring: { profile?: string } }>('/api/achievements', async (req, reply) => {
    const profile = profiles.get(req.query.profile);
    if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
    return achievements.summary(profile.id);
  });
  app.get<{ Params: { game: string }; Querystring: { profile?: string } }>('/api/achievements/game/:game', async (req, reply) => {
    const profile = profiles.get(req.query.profile);
    if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
    try {
      return await achievements.forGame(profile.id, req.params.game);
    } catch (err) {
      return achievementFail(reply, err);
    }
  });
  app.post<{ Params: { profile: string; game: string }; Body: { id?: unknown } }>(
    '/api/achievements/:profile/:game',
    async (req, reply) => {
      const profile = profiles.get(req.params.profile);
      if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
      // Só o jogo do cartucho inserido agora desbloqueia (e só as conquistas do playzin.json dele).
      const cartridge = manager.current;
      if (!cartridge || cartridge.manifest.id !== req.params.game) {
        return reply.code(409).send({ error: 'esse jogo não está no console agora' });
      }
      if (typeof req.body?.id !== 'string') return reply.code(400).send({ error: '"id" da conquista é obrigatório' });
      try {
        return await achievements.unlock(profile.id, cartridge.manifest, req.body.id);
      } catch (err) {
        return achievementFail(reply, err);
      }
    },
  );

  // ---- Capturas de tela: o launcher tira a foto do jogo e manda para o álbum ----
  const shotFail = (reply: import('fastify').FastifyReply, err: unknown) =>
    reply.code(err instanceof ScreenshotError ? err.status : 500).send({ error: (err as Error).message });

  app.get('/api/screenshots', async () => ({ screenshots: await screenshots.list() }));
  app.post<{ Body: { game?: unknown; profile?: unknown; image?: unknown; thumb?: unknown; width?: unknown; height?: unknown } }>(
    '/api/screenshots',
    // JPEG em base64 (+ a miniatura): um terço maior que a imagem.
    { bodyLimit: Math.ceil(SCREENSHOT_MAX_BYTES * 1.4) + 512 * 1024 },
    async (req, reply) => {
      const body = req.body ?? {};
      // Só o jogo do cartucho inserido agora (o nome vem do playzin.json dele).
      const cartridge = manager.current;
      if (!cartridge || cartridge.manifest.id !== body.game) {
        return reply.code(409).send({ error: 'esse jogo não está no console agora' });
      }
      if (typeof body.image !== 'string' || typeof body.thumb !== 'string') {
        return reply.code(400).send({ error: '"image" e "thumb" (JPEG em base64) são obrigatórios' });
      }
      const profile = typeof body.profile === 'string' ? (profiles.get(body.profile)?.id ?? null) : null;
      try {
        const shot = await screenshots.add(cartridge.manifest, profile, {
          image: Buffer.from(body.image, 'base64'),
          thumb: Buffer.from(body.thumb, 'base64'),
          width: body.width,
          height: body.height,
        });
        req.log.info(`[capturas] ${shot.id} (${cartridge.manifest.id}, ${Math.round(shot.bytes / 1024)} KB)`);
        return reply.code(201).send(shot);
      } catch (err) {
        return shotFail(reply, err);
      }
    },
  );
  app.get<{ Params: { file: string } }>('/api/screenshots/:file', async (req, reply) => {
    const match = /^(.+?)(\.thumb)?\.jpg$/.exec(req.params.file);
    const file = match ? await screenshots.filePath(match[1]!, Boolean(match[2])) : null;
    if (!file) return reply.code(404).send({ error: 'captura não encontrada' });
    // O id nunca se repete: a imagem de um endereço não muda.
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.sendFile(path.basename(file), path.dirname(file), { cacheControl: false });
  });
  app.delete<{ Params: { id: string } }>('/api/screenshots/:id', async (req, reply) => {
    try {
      return (await screenshots.remove(req.params.id)) ? reply.code(204).send() : reply.code(404).send({ error: 'captura não encontrada' });
    } catch (err) {
      return shotFail(reply, err);
    }
  });

  // ---- Saves de um perfil: tela "Dados salvos" ----
  app.get<{ Querystring: { profile?: string } }>('/api/saves', async (req, reply) => {
    const profile = profiles.get(req.query.profile);
    if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
    return { saves: await saves.list(profile.id) };
  });
  app.delete<{ Params: { profile: string; id: string } }>('/api/saves/:profile/:id', async (req, reply) => {
    const profile = profiles.get(req.params.profile);
    if (!profile) return reply.code(404).send({ error: 'perfil desconhecido' });
    try {
      const cleared = await saves.clear(profile.id, req.params.id);
      lastWriteAt.set(`${profile.id}/${req.params.id}`, Date.now());
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
    send(socket, { type: 'profiles', profiles: profiles.list() });
    send(socket, { type: 'bluetooth', state: bluetooth.state() });
    send(socket, { type: 'wifi', state: wifi.state() });
    send(socket, { type: 'power', state: power.state() });
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
  manager.on('inserted', (cartridge) => {
    // Guarda as conquistas do jogo, para a tela Atividade mostrar "2 de 4" mesmo sem o cartucho.
    achievements.remember(cartridge.manifest).catch((err: Error) => app.log.warn(`[conquistas] ${err.message}`));
    broadcast({ type: 'cartridge-inserted', cartridge });
  });
  manager.on('removed', (slotId) => broadcast({ type: 'cartridge-removed', slotId }));
  manager.on('error', (message, source) => broadcast({ type: 'cartridge-error', message, source }));
  profiles.on('change', (list) => broadcast({ type: 'profiles', profiles: list }));
  bluetooth.on('state', (state) => broadcast({ type: 'bluetooth', state }));
  bluetooth.on('paired', (device, auto) => broadcast({ type: 'bluetooth-paired', device, auto }));
  bluetooth.on('error', (message, address) => broadcast({ type: 'bluetooth-error', message, address }));
  wifi.on('state', (state) => broadcast({ type: 'wifi', state }));
  wifi.on('connected', (ssid) => broadcast({ type: 'wifi-connected', ssid }));
  wifi.on('error', (message, ssid, wrongPassword) => broadcast({ type: 'wifi-error', message, ssid, wrongPassword }));
  power.on('action', (action, simulated) => broadcast({ type: 'power-action', action, simulated }));
  power.on('error', (message) => broadcast({ type: 'power-error', message }));

  return app;
}

function samePath(a: string, b: string): boolean {
  return path.posix.normalize(a.replace(/\\/g, '/')) === path.posix.normalize(b.replace(/\\/g, '/'));
}

function send(socket: { readyState: number; send: (data: string) => void }, msg: ServerMessage): void {
  if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(msg));
}
