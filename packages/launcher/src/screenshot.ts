/**
 * Captura de tela do jogo, feita pelo launcher (o jogo não precisa fazer nada).
 *
 * O jogo roda num iframe da mesma origem, então o launcher enxerga os <canvas> dele. O detalhe
 * é o WebGL (Phaser, Pixi, three.js): sem `preserveDrawingBuffer`, o navegador limpa o canvas
 * assim que o quadro vai para a tela, e ler depois disso dá uma imagem vazia. Por isso a leitura
 * acontece DENTRO de um requestAnimationFrame do próprio iframe: o callback do jogo para o
 * próximo quadro já estava na fila antes do nosso, então quando o nosso roda o jogo acabou de
 * desenhar e o quadro ainda não foi para a tela.
 *
 * Os canvas visíveis são montados numa imagem só, na posição em que aparecem, com a resolução
 * nativa do canvas principal (pixel art não fica borrada). Elementos HTML por cima do canvas
 * (textos, botões feitos em HTML) não entram.
 */

/** Lado maior da captura. Mais que isso só pesa no cartão de memória. */
const MAX_LONG_SIDE = 1920;
/** Pixel art muito pequena (ex.: 320x180) é ampliada, sem borrar, até pelo menos esta altura. */
const MIN_HEIGHT = 720;
const THUMB_WIDTH = 320;
const JPEG_QUALITY = 0.92;
/** Se o jogo não desenhar mais quadros (travado, em segundo plano), lê assim mesmo depois disso. */
const FRAME_TIMEOUT_MS = 500;

export interface CapturedImage {
  image: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

export class CaptureError extends Error {
  constructor(
    readonly reason: 'no-game' | 'no-canvas' | 'blank' | 'blocked',
    message: string,
  ) {
    super(message);
  }
}

export async function captureFrame(frame: HTMLIFrameElement): Promise<CapturedImage> {
  let win: Window | null;
  let doc: Document | null;
  try {
    win = frame.contentWindow;
    doc = frame.contentDocument;
  } catch {
    win = doc = null;
  }
  if (!win || !doc) throw new CaptureError('no-game', 'O jogo ainda não carregou');

  const canvas = await new Promise<HTMLCanvasElement>((resolve, reject) => {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      try {
        resolve(compose(win!, doc!));
      } catch (err) {
        // Canvas "contaminado" por imagens de outro site: o navegador não deixa ler.
        reject(err instanceof CaptureError ? err : new CaptureError('blocked', 'Este jogo não permite capturar a tela'));
      }
    };
    const timer = window.setTimeout(run, FRAME_TIMEOUT_MS);
    try {
      win!.requestAnimationFrame(() => {
        window.clearTimeout(timer);
        run();
      });
    } catch {
      window.clearTimeout(timer);
      run();
    }
  });

  try {
    const image = await toJpeg(canvas, JPEG_QUALITY);
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = Math.max(1, Math.round((THUMB_WIDTH * canvas.height) / canvas.width));
    const ctx = thumbCanvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = await toJpeg(thumbCanvas, 0.8);
    return { image, thumb, width: canvas.width, height: canvas.height };
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    // Canvas "contaminado" por imagens de outro site: o navegador não deixa ler.
    throw new CaptureError('blocked', 'Este jogo não permite capturar a tela');
  }
}

/** Monta os canvas visíveis do jogo numa imagem só. Roda dentro do quadro do jogo (síncrono). */
function compose(win: Window, doc: Document): HTMLCanvasElement {
  const layers = [...doc.querySelectorAll('canvas')]
    .map((el, order) => ({ el, rect: el.getBoundingClientRect(), style: win.getComputedStyle(el), order }))
    .filter(
      ({ el, rect, style }) =>
        el.width > 0 &&
        el.height > 0 &&
        rect.width > 1 &&
        rect.height > 1 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < win.innerWidth &&
        rect.top < win.innerHeight &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) > 0,
    )
    // Quem tem z-index maior fica por cima; empate: a ordem no HTML.
    .sort((a, b) => zIndex(a.style) - zIndex(b.style) || a.order - b.order);
  if (layers.length === 0) throw new CaptureError('no-canvas', 'Este jogo não pode ser capturado (ele não desenha num canvas)');

  // Escala = resolução nativa do maior canvas (um jogo 1280x720 esticado na TV sai 1280x720).
  const main = layers.reduce((a, b) => (b.rect.width * b.rect.height > a.rect.width * a.rect.height ? b : a));
  const viewW = win.innerWidth;
  const viewH = win.innerHeight;
  let scale = main.el.width / main.rect.width;
  scale = Math.min(scale, MAX_LONG_SIDE / Math.max(viewW, viewH));
  if (viewH * scale < MIN_HEIGHT) {
    // Ampliação inteira (2x, 3x…): cada pixel do jogo vira um quadradinho, sem borrar.
    const k = Math.ceil(MIN_HEIGHT / (viewH * scale));
    scale = Math.min(scale * k, MAX_LONG_SIDE / Math.max(viewW, viewH));
  }
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(viewW * scale));
  out.height = Math.max(1, Math.round(viewH * scale));
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = backgroundOf(win, doc);
  ctx.fillRect(0, 0, out.width, out.height);

  let painted = false;
  for (const { el, rect, style } of layers) {
    if (!painted && hasPixels(el)) painted = true;
    const w = rect.width * scale;
    // Ampliando: sem suavização (pixel art nítida). Reduzindo: com.
    ctx.imageSmoothingEnabled = w < el.width && style.imageRendering !== 'pixelated';
    ctx.globalAlpha = Math.min(1, Number(style.opacity) || 1);
    ctx.drawImage(el, rect.left * scale, rect.top * scale, w, rect.height * scale);
  }
  ctx.globalAlpha = 1;
  if (!painted) throw new CaptureError('blank', 'Não deu para capturar esta tela. Tente de novo');
  return out;
}

/** O canvas tem alguma coisa desenhada? (WebGL lido fora de hora vem todo transparente.) */
function hasPixels(el: HTMLCanvasElement): boolean {
  const probe = document.createElement('canvas');
  probe.width = probe.height = 16;
  const ctx = probe.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(el, 0, 0, 16, 16);
  const data = ctx.getImageData(0, 0, 16, 16).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
  return false;
}

function zIndex(style: CSSStyleDeclaration): number {
  const z = Number.parseInt(style.zIndex, 10);
  return Number.isFinite(z) ? z : 0;
}

/** Fundo da página do jogo (o que aparece nas bordas quando o canvas não ocupa a tela toda). */
function backgroundOf(win: Window, doc: Document): string {
  for (const el of [doc.body, doc.documentElement]) {
    if (!el) continue;
    const color = win.getComputedStyle(el).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return '#000';
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('falha ao gerar a imagem'))), 'image/jpeg', quality);
  });
}

/** Blob → base64 (sem o "data:...;base64,"), para mandar no JSON. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('falha ao ler a imagem'));
    reader.readAsDataURL(blob);
  });
}
