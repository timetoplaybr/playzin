/** Ícones SVG simples (traço), herdam a cor do texto via currentColor. */
const svg = (body: string, viewBox = '0 0 24 24') =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>'),
  wifi: svg('<path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>'),
  wifiOff: svg('<path d="M2 2l20 20"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><path d="M5 12a10 10 0 0 1 5-2.7"/><path d="M2 8.5A15 15 0 0 1 7 5.6"/><circle cx="12" cy="19" r="1" fill="currentColor"/>'),
  gamepad: svg('<path d="M6 11h4M8 9v4"/><circle cx="15" cy="12" r="0.6" fill="currentColor"/><circle cx="17.5" cy="10" r="0.6" fill="currentColor"/><path d="M7 6h10a5 5 0 0 1 4.9 6l-.9 4.4a2.5 2.5 0 0 1-4.3 1.2L14.5 15h-5l-2.2 2.6A2.5 2.5 0 0 1 3 16.4L2.1 12A5 5 0 0 1 7 6z"/>'),
  cartridge: svg('<path d="M6 3h12v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M9 6h6v6H9z"/><path d="M9 19v2M12 19v2M15 19v2"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/>'),
  power: svg('<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>'),
  library: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  save: svg('<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M8 3v5h7V3"/><rect x="8" y="13" width="8" height="6" rx="1"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  mouse: svg('<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  activity: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  chevronLeft: svg('<path d="M15 5l-7 7 7 7"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  wifi1: svg('<path class="arc a3" d="M2 8.5a15 15 0 0 1 20 0"/><path class="arc a2" d="M5 12a10 10 0 0 1 14 0"/><path class="arc a1" d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>'),
  trophy: svg('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8.5 20h7M9.5 17h5"/>'),
  lockSmall: svg('<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z"/>'),
  insert: svg('<path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M5 17v3h14v-3"/>'),
};

/** Ícones de perfil: desenhos cheios, próprios do Playzin (nada de personagens de terceiros). */
const glyph = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${body}</svg>`;
const ray = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"';
const shade = 'fill="rgba(0,0,0,0.28)"';

export const profileIcons: Record<import('@playzin/shared').ProfileIcon, string> = {
  star: glyph('<path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.5 1.3 6.6L12 17.2l-5.9 3.3 1.3-6.6-4.9-4.5 6.6-.8z"/>'),
  heart: glyph(
    '<path d="M12 20.5s-7.6-4.5-9.4-9.2C1.2 7.6 3.4 4.2 7 4.2c2 0 3.5 1 5 2.9 1.5-1.9 3-2.9 5-2.9 3.6 0 5.8 3.4 4.4 7.1-1.8 4.7-9.4 9.2-9.4 9.2z"/>',
  ),
  bolt: glyph('<path d="M13.6 2 4.8 13.4h5.9L9.4 22l9.8-12h-6z"/>'),
  moon: glyph('<path d="M19.8 15.2A8.6 8.6 0 0 1 8.8 4.2 8.6 8.6 0 1 0 19.8 15.2z"/><circle cx="17" cy="5" r="1.3"/><circle cx="20.5" cy="9" r="0.9"/>'),
  sun: glyph(
    `<circle cx="12" cy="12" r="4.6"/><path ${ray} d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>`,
  ),
  leaf: glyph(`<path d="M5 18.5C4.4 10 9.6 4.2 20.5 3.5 20.4 14 15 19.4 6.6 19z"/><path ${ray} d="M3.5 20.5c3-4.5 6.5-8 11-10.5"/>`),
  music: glyph(
    '<path d="M9.5 6.6 19.5 4v11.2a3.1 3.1 0 1 1-2-2.9V8.1l-6 1.6v7.5a3.1 3.1 0 1 1-2-2.9z"/>',
  ),
  rocket: glyph(
    `<path d="M12 2c3.4 2.3 5 5.8 5 9.6l-1.8 4.6H8.8L7 11.6C7 7.8 8.6 4.3 12 2z"/><circle cx="12" cy="9.6" r="1.9" ${shade}/>` +
      '<path d="M7.3 12.6 4.2 15.7v3.2l4.1-1.4zM16.7 12.6l3.1 3.1v3.2l-4.1-1.4zM10 17.4h4L12 22z"/>',
  ),
  crown: glyph('<path d="M3 7.5l4.6 4.1L12 4.5l4.4 7.1L21 7.5l-1.9 10.8H4.9z"/><rect x="5" y="19.3" width="14" height="2" rx="1"/>'),
  cat: glyph(
    `<path d="M4 3.5l4.3 4h7.4L20 3.5v9.3a8 8 0 0 1-16 0z"/><ellipse cx="9" cy="12.6" rx="1.2" ry="1.7" ${shade}/>` +
      `<ellipse cx="15" cy="12.6" rx="1.2" ry="1.7" ${shade}/><path ${shade} d="M10.8 16h2.4L12 17.3z"/>`,
  ),
  paw: glyph(
    '<ellipse cx="6" cy="10" rx="2.1" ry="2.7"/><ellipse cx="10" cy="5.8" rx="2.1" ry="2.8"/><ellipse cx="14" cy="5.8" rx="2.1" ry="2.8"/>' +
      '<ellipse cx="18" cy="10" rx="2.1" ry="2.7"/><path d="M12 11.5c3 0 6 4.3 6 6.6 0 1.9-1.7 2.6-3.2 2.2-1-.3-1.8-.7-2.8-.7s-1.8.4-2.8.7C7.7 20.7 6 20 6 18.1c0-2.3 3-6.6 6-6.6z"/>',
  ),
  flower: glyph(
    '<circle cx="12" cy="6" r="3.4"/><circle cx="17.7" cy="10.1" r="3.4"/><circle cx="15.5" cy="16.8" r="3.4"/>' +
      `<circle cx="8.5" cy="16.8" r="3.4"/><circle cx="6.3" cy="10.1" r="3.4"/><circle cx="12" cy="12" r="3" fill="#fff6c9"/>`,
  ),
};
