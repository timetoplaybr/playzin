import * as Phaser from 'phaser';
import { createSaveStore, exitToMenu, isInsidePlayzin, onLauncherMessage, PlayerInput, ready, unlockAchievement } from 'playzin/sdk';

const WIDTH = 1280;
const HEIGHT = 720;
const GAME_ID = 'hello-playzin'; // o mesmo "id" do playzin.json
const saves = createSaveStore(GAME_ID);

/**
 * Cartucho de exemplo. Mostra o básico do SDK:
 * - PlayerInput: mesmo código para teclado e controle
 * - createSaveStore: recorde salvo por jogo
 * - ready() e exitToMenu(): conversa com o launcher
 * - onLauncherMessage(): pausa o relógio enquanto o menu rápido do console está aberto
 * - unlockAchievement(): conquistas declaradas no playzin.json
 */
class PlayScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Rectangle;
  private star!: Phaser.GameObjects.Star;
  private scoreText!: Phaser.GameObjects.Text;
  private padText!: Phaser.GameObjects.Text;
  private controls!: PlayerInput;
  private score = 0;
  private best = 0;
  private timeLeft = 30;
  private finished = false;

  constructor() {
    super('play');
  }

  create(): void {
    this.controls = new PlayerInput({ player: 0 });
    this.score = 0;
    this.timeLeft = 30;
    this.finished = false;
    this.best = saves.get('best', 0);

    this.cameras.main.setBackgroundColor('#14123a');
    this.player = this.add.rectangle(WIDTH / 2, HEIGHT / 2, 48, 48, 0x4cff8a);
    this.star = this.add.star(0, 0, 5, 14, 30, 0xffcc33);
    this.moveStar();

    const style = { fontFamily: 'system-ui, sans-serif', fontSize: '28px', color: '#ffffff' };
    this.scoreText = this.add.text(24, 20, '', style);
    this.padText = this.add.text(24, HEIGHT - 44, '', { ...style, fontSize: '20px', color: '#a99fd6' });
    this.add
      .text(WIDTH - 24, HEIGHT - 44, isInsidePlayzin() ? 'Segure Esc / botão Xbox: menu' : 'Rodando fora do console', {
        ...style,
        fontSize: '20px',
        color: '#a99fd6',
      })
      .setOrigin(1, 0);

    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (this.finished) return;
        this.timeLeft -= 1;
        if (this.timeLeft <= 0) this.finish();
      },
    });

    // Menu rápido aberto (botão Xbox / Esc segurado): o relógio da partida para.
    const stop = onLauncherMessage((type) => (this.time.paused = type === 'pause'));
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, stop);

    ready(); // avisa o launcher que pode tirar a tela de "carregando"
  }

  update(_time: number, delta: number): void {
    this.controls.update();
    this.padText.setText(this.controls.hasGamepad ? 'Controle conectado' : 'Teclado: setas ou WASD');

    if (this.finished) {
      if (this.controls.justPressed('confirm')) this.scene.restart();
      if (this.controls.justPressed('back')) exitToMenu();
      return;
    }

    const speed = 0.45 * delta;
    const move = this.controls.getMove();
    this.player.x = Phaser.Math.Clamp(this.player.x + move.x * speed, 24, WIDTH - 24);
    this.player.y = Phaser.Math.Clamp(this.player.y + move.y * speed, 24, HEIGHT - 24);
    this.star.rotation += 0.002 * delta;

    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this.star.x, this.star.y) < 48) {
      this.score += 1;
      this.controls.rumble(80, 0.4);
      // Conquistas (declaradas no playzin.json). Chamar de novo não repete o aviso.
      unlockAchievement('primeira-estrela');
      if (this.score >= 10) unlockAchievement('dez-estrelas');
      if (this.timeLeft <= 1) unlockAchievement('ultimo-segundo');
      this.tweens.add({ targets: this.player, scale: 1.3, duration: 80, yoyo: true });
      this.moveStar();
    }

    this.scoreText.setText(`Estrelas: ${this.score}    Tempo: ${this.timeLeft}s    Recorde: ${this.best}`);
  }

  private moveStar(): void {
    this.star.setPosition(Phaser.Math.Between(80, WIDTH - 80), Phaser.Math.Between(100, HEIGHT - 100));
  }

  private finish(): void {
    this.finished = true;
    const record = this.score > this.best;
    if (record && this.best > 0) unlockAchievement('recorde'); // a primeira partida não conta
    if (record) {
      this.best = this.score;
      saves.set('best', this.best);
    }
    this.scoreText.setText(`Estrelas: ${this.score}    Recorde: ${this.best}`);
    this.add
      .text(WIDTH / 2, HEIGHT / 2 - 30, record ? 'Novo recorde!' : 'Fim de jogo', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '64px',
        fontStyle: 'bold',
        color: '#ffcc33',
      })
      .setOrigin(0.5);
    this.add
      .text(WIDTH / 2, HEIGHT / 2 + 40, 'A / Enter: jogar de novo     B / Backspace: voltar ao menu', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: '#000000',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [PlayScene],
});
