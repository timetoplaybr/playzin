/**
 * Sons da interface, sintetizados na hora (sem arquivos de áudio).
 * Curtos e discretos: um "tic" para navegar, um acorde para confirmar,
 * um "clac" para quando o cartucho encaixa.
 */
export class Sounds {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;

  constructor(private volume = 0.5) {
    // O navegador só libera áudio depois de uma interação (no Pi, a flag do
    // Chromium libera desde o início). Destrava na primeira tecla/clique.
    const unlock = () => this.ensure();
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  move(): void {
    this.tone(1320, 0.035, 'triangle', 0.35);
  }

  select(): void {
    this.tone(880, 0.06, 'triangle', 0.45);
    this.tone(1320, 0.09, 'triangle', 0.4, 0.05);
  }

  back(): void {
    this.tone(990, 0.05, 'triangle', 0.4);
    this.tone(660, 0.07, 'triangle', 0.35, 0.04);
  }

  error(): void {
    this.tone(220, 0.08, 'square', 0.18);
    this.tone(196, 0.12, 'square', 0.18, 0.08);
  }

  /** Cartucho encaixou: "clac" + acorde subindo. */
  insert(): void {
    this.click(0, 0.6);
    this.click(0.05, 0.4);
    this.tone(523.25, 0.12, 'sine', 0.35, 0.12);
    this.tone(783.99, 0.18, 'sine', 0.35, 0.2);
    this.tone(1046.5, 0.28, 'sine', 0.3, 0.28);
  }

  /** Cartucho saiu: acorde descendo. */
  eject(): void {
    this.click(0, 0.4);
    this.tone(783.99, 0.1, 'sine', 0.3, 0.05);
    this.tone(523.25, 0.18, 'sine', 0.3, 0.13);
  }

  launch(): void {
    this.tone(659.25, 0.08, 'triangle', 0.4);
    this.tone(987.77, 0.08, 'triangle', 0.4, 0.07);
    this.tone(1318.5, 0.25, 'triangle', 0.35, 0.14);
  }

  /** Desligando: o acorde da abertura, descendo. */
  powerOff(): void {
    const notes = [1046.5, 783.99, 659.25, 523.25]; // dó, sol, mi, dó
    notes.forEach((f, i) => this.tone(f, 0.4, 'sine', 0.3, i * 0.11));
  }

  /** Abertura: o cartucho encaixando na fenda. */
  bootClick(): void {
    this.click(0, 0.7);
    this.click(0.045, 0.45);
    this.tone(110, 0.12, 'sine', 0.5);
  }

  /** Abertura: acorde de boas-vindas subindo e brilhando. */
  bootChime(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5]; // dó, mi, sol, dó
    notes.forEach((f, i) => {
      this.tone(f, 0.5 - i * 0.05, 'sine', 0.38, i * 0.085);
      this.tone(f * 2, 0.25, 'triangle', 0.08, i * 0.085);
    });
    this.tone(1567.98, 0.9, 'sine', 0.22, 0.36); // brilho final
  }

  private ensure(): AudioContext | undefined {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return undefined;
    }
  }

  private tone(freq: number, duration: number, type: OscillatorType, gain: number, delay = 0): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain * 0.25, start + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(env).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** Ruído curtinho filtrado: soa como um encaixe plástico. */
  private click(delay: number, gain: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const length = Math.floor(ctx.sampleRate * 0.03);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400;
    const env = ctx.createGain();
    env.gain.value = gain * 0.6;
    src.connect(filter).connect(env).connect(this.master);
    src.start(ctx.currentTime + delay);
  }
}
