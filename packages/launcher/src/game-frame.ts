import { GamepadButton, getConnectedGamepads } from '@playzin/sdk';
import type {
  AchievementUnlock,
  CartridgeInfo,
  GameAchievements,
  GameToLauncherMessage,
  LauncherToGameMessage,
  Profile,
} from '@playzin/shared';
import { PlaytimeTracker } from './playtime';
import { QuickMenu } from './ui/quick-menu';
import type { GameToast } from './ui/game-toast';
import type { Sounds } from './ui/sounds';

const HOLD_TO_MENU_MS = 1000;

/** O que o script de saves injetado pelo daemon expõe dentro do iframe do jogo. */
interface GameSaves {
  snapshot(): Record<string, string>;
  /** null = visitante, nada é gravado */
  url: string | null;
}
const READY_FALLBACK_MS = 400;

/**
 * Roda o jogo do cartucho num iframe em tela cheia por cima do menu.
 * O launcher continua vivo por baixo, então ele percebe a remoção do cartucho
 * e os atalhos do menu rápido mesmo que o jogo não use o SDK.
 *
 * Menu rápido (continuar, reiniciar, sair), que pausa o jogo por baixo:
 *  - botão Xbox/PS (Guide), ou View + Menu segurados por 1 s
 *  - Esc segurado por 1 s
 * O jogo também pode voltar direto ao menu chamando exitToMenu() do SDK.
 */
export class GameFrame {
  private readonly frame = document.getElementById('cartridge-frame') as HTMLIFrameElement;
  private readonly loading = document.getElementById('loading') as HTMLDivElement;
  private readonly loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
  private current: CartridgeInfo | null = null;
  private rafId: number | undefined;
  private comboSince: number | null = null;
  private escSince: number | null = null;
  private escTimer: number | undefined;
  private detachKeyboard: (() => void) | undefined;
  private readonly playtime = new PlaytimeTracker();
  private readonly menu: QuickMenu;
  private guideWasDown = false;
  private gameUrl = '';
  private profileId: string | null = null;
  /** Conquistas que o perfil já tem neste jogo (o SDK lê em __playzinAchievements). */
  private achievements = new Set<string>();
  private achievementsPending = new Set<string>();
  /** Áudio/vídeo do jogo que o menu pausou (para voltar a tocar ao fechar). */
  private pausedMedia: HTMLMediaElement[] = [];
  /** Resolve quando o tempo da última partida foi guardado pelo daemon. */
  lastPlaytimeSaved: Promise<void> = Promise.resolve();

  constructor(
    private readonly onExit: () => void,
    private readonly sounds: Sounds,
    private readonly toast: GameToast,
  ) {
    window.addEventListener('message', (event) => this.onMessage(event));
    this.menu = new QuickMenu(sounds, {
      resume: () => this.resume(),
      restart: () => void this.restart(),
      quit: () => this.requestExit(),
    });
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** Abre o jogo com os saves do perfil indicado. */
  open(cartridge: CartridgeInfo, profile: Profile | null): void {
    const profileId = profile?.id ?? null;
    this.current = cartridge;
    this.profileId = profileId;
    this.menu.setGame(cartridge, profile);
    this.publishAchievements(new Set());
    this.achievementsPending.clear();
    void this.loadAchievements(cartridge, profileId);
    // O Guide só conta depois de solto uma vez (não abre o menu se já estava apertado).
    this.guideWasDown = true;
    this.loadingText.textContent = `Carregando ${cartridge.manifest.name}…`;
    this.loading.hidden = false;

    const url = new URL(cartridge.entryUrl, location.href);
    url.searchParams.set('playzin', '1');
    if (profileId) url.searchParams.set('profile', profileId);

    if (profileId) this.playtime.start(profileId, cartridge.manifest.id, cartridge.manifest.name);
    this.frame.onload = () => {
      this.attachKeyboard();
      this.playtime.watchWindow(this.frame.contentWindow);
      // Jogos sem o SDK nunca mandam "ready": mostramos mesmo assim.
      window.setTimeout(() => this.reveal(), READY_FALLBACK_MS);
    };
    this.gameUrl = url.toString();
    this.frame.src = this.gameUrl;
    this.frame.hidden = false;
    this.watchGamepads();
  }

  close(): void {
    if (!this.current) return;
    this.menu.hide();
    this.menu.setGame(null, null);
    this.publishAchievements(new Set());
    this.profileId = null;
    this.pausedMedia = [];
    void this.saveNow();
    this.lastPlaytimeSaved = this.playtime.stop();
    this.current = null;
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    this.rafId = undefined;
    this.detachKeyboard?.();
    this.detachKeyboard = undefined;
    window.clearTimeout(this.escTimer);
    this.comboSince = this.escSince = null;
    // about:blank descarrega o jogo de verdade (para áudio, timers, WebGL).
    this.frame.onload = null;
    this.frame.src = 'about:blank';
    this.frame.hidden = true;
    this.loading.hidden = true;
    window.focus();
  }

  /**
   * Gravação dos saves direto do launcher (que continua vivo), então não há limite de
   * tamanho nem risco de a página fechar antes. Resolve quando o daemon respondeu.
   */
  private async saveNow(): Promise<void> {
    try {
      const saves = (this.frame.contentWindow as unknown as { __playzinSaves?: GameSaves } | null)?.__playzinSaves;
      if (!saves?.url) return;
      const body = JSON.stringify({ data: saves.snapshot(), at: Date.now() });
      await fetch(saves.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }).catch(() => undefined);
    } catch {
      /* iframe já descarregado ou de outra origem */
    }
  }

  private reveal(): void {
    if (!this.current || this.menu.isOpen) return;
    this.loading.hidden = true;
    this.frame.focus();
    this.frame.contentWindow?.focus();
  }

  private requestExit(): void {
    if (!this.current) return;
    this.close();
    this.onExit();
  }

  // ---------------------------------------------------------------- menu rápido

  private openMenu(): void {
    if (!this.current || this.menu.isOpen) return;
    // Os atalhos de segurar recomeçam do zero na volta.
    this.comboSince = this.escSince = null;
    window.clearTimeout(this.escTimer);
    this.post('pause');
    this.pauseMedia();
    // O teclado passa a ir para o launcher (e não para o jogo) enquanto o menu está aberto.
    this.frame.blur();
    window.focus();
    this.menu.open();
  }

  private resume(): void {
    if (!this.current) return;
    this.post('resume');
    this.resumeMedia();
    this.frame.focus();
    this.frame.contentWindow?.focus();
  }

  /** Recarrega o jogo do começo. Grava os saves antes, porque o jogo os recebe ao carregar. */
  private async restart(): Promise<void> {
    const cartridge = this.current;
    if (!cartridge) return;
    this.pausedMedia = [];
    this.loadingText.textContent = `Reiniciando ${cartridge.manifest.name}…`;
    this.loading.hidden = false;
    await this.saveNow();
    if (this.current !== cartridge) return; // o cartucho saiu enquanto gravava
    this.detachKeyboard?.();
    this.detachKeyboard = undefined;
    this.frame.src = this.gameUrl;
  }

  private post(type: LauncherToGameMessage['type']): void {
    const msg: LauncherToGameMessage = { source: 'playzin-launcher', type };
    try {
      this.frame.contentWindow?.postMessage(msg, location.origin);
    } catch {
      /* iframe descarregado */
    }
  }

  /** Jogos sem o SDK não sabem pausar: pelo menos o áudio e o vídeo da página param. */
  private pauseMedia(): void {
    try {
      const doc = this.frame.contentDocument;
      this.pausedMedia = doc ? [...doc.querySelectorAll<HTMLMediaElement>('audio, video')].filter((m) => !m.paused) : [];
      for (const m of this.pausedMedia) m.pause();
    } catch {
      this.pausedMedia = [];
    }
  }

  private resumeMedia(): void {
    for (const m of this.pausedMedia) void m.play().catch(() => undefined);
    this.pausedMedia = [];
  }

  private onMessage(event: MessageEvent): void {
    if (event.origin !== location.origin || event.source !== this.frame.contentWindow) return;
    const data = event.data as Partial<GameToLauncherMessage> | undefined;
    if (data?.source !== 'playzin-sdk') return;
    if (data.type === 'ready') this.reveal();
    if (data.type === 'exit') this.requestExit();
    if (data.type === 'achievement' && typeof data.id === 'string') void this.unlockAchievement(data.id);
  }

  // ---------------------------------------------------------------- conquistas

  private publishAchievements(ids: Set<string>): void {
    this.achievements = ids;
    (window as unknown as { __playzinAchievements?: string[] }).__playzinAchievements = [...ids];
  }

  /** O que o perfil já desbloqueou neste jogo (para isAchievementUnlocked e o menu rápido). */
  private async loadAchievements(cartridge: CartridgeInfo, profileId: string | null): Promise<void> {
    if (!profileId || !cartridge.manifest.achievements?.length) return this.menu.setAchievements(0, 0);
    try {
      const url = `/api/achievements/game/${encodeURIComponent(cartridge.manifest.id)}?profile=${encodeURIComponent(profileId)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const game = (await res.json()) as GameAchievements;
      if (this.current !== cartridge) return;
      const ids = new Set(game.achievements.filter((a) => a.unlockedAt).map((a) => a.id));
      for (const id of this.achievements) ids.add(id); // desbloqueadas enquanto carregava
      this.publishAchievements(ids);
      this.menu.setAchievements(ids.size, cartridge.manifest.achievements.length);
    } catch {
      this.menu.setAchievements(this.achievements.size, cartridge.manifest.achievements.length);
    }
  }

  private async unlockAchievement(id: string): Promise<void> {
    const cartridge = this.current;
    const profileId = this.profileId;
    if (!cartridge || !profileId || this.achievements.has(id) || this.achievementsPending.has(id)) return;
    this.achievementsPending.add(id);
    try {
      const url = `/api/achievements/${encodeURIComponent(profileId)}/${encodeURIComponent(cartridge.manifest.id)}`;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const body = (await res.json().catch(() => ({}))) as Partial<AchievementUnlock> & { error?: string };
      if (!res.ok || !body.achievement) {
        // Erro de quem fez o jogo (conquista fora do playzin.json): só no console do navegador.
        console.warn(`[conquistas] ${body.error ?? `erro ${res.status}`}`);
        return;
      }
      if (this.current !== cartridge) return;
      this.publishAchievements(new Set([...this.achievements, id]));
      this.menu.setAchievements(body.unlocked ?? this.achievements.size, body.total ?? 0);
      if (body.isNew) {
        this.sounds.achievement();
        this.toast.achievement(body.achievement.name, body.unlocked ?? 0, body.total ?? 0);
      }
    } catch (err) {
      console.warn(`[conquistas] ${(err as Error).message}`);
    } finally {
      this.achievementsPending.delete(id);
    }
  }

  /** O jogo é da mesma origem, então dá para escutar o teclado dentro do iframe. */
  private attachKeyboard(): void {
    this.detachKeyboard?.();
    const win = this.frame.contentWindow;
    if (!win) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' || this.escSince !== null) return;
      this.escSince = performance.now();
      this.escTimer = window.setTimeout(() => this.openMenu(), HOLD_TO_MENU_MS);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      this.escSince = null;
      window.clearTimeout(this.escTimer);
    };
    try {
      win.addEventListener('keydown', down);
      win.addEventListener('keyup', up);
      this.detachKeyboard = () => {
        try {
          win.removeEventListener('keydown', down);
          win.removeEventListener('keyup', up);
        } catch {
          /* iframe já descarregado */
        }
      };
    } catch {
      /* origem diferente: só sobra o SDK e o controle */
    }
  }

  private watchGamepads(): void {
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
    const tick = () => {
      if (!this.current) return;
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      let guide = false;
      let combo = false;
      for (const pad of getConnectedGamepads()) {
        if (pad.buttons[GamepadButton.GUIDE]?.pressed) guide = true;
        if (pad.buttons[GamepadButton.VIEW]?.pressed && pad.buttons[GamepadButton.MENU]?.pressed) combo = true;
      }
      const guidePressed = guide && !this.guideWasDown;
      this.guideWasDown = guide;

      if (this.menu.isOpen) {
        // Guide de novo fecha o menu e volta ao jogo, como nos consoles.
        if (guidePressed) {
          this.menu.hide();
          this.resume();
          return;
        }
        this.menu.update();
        return;
      }
      if (guidePressed) return this.openMenu();
      if (combo) {
        this.comboSince ??= now;
        if (now - this.comboSince >= HOLD_TO_MENU_MS) this.openMenu();
      } else {
        this.comboSince = null;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }
}
