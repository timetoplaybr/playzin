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
  insert: svg('<path d="M12 3v11"/><path d="M8 10l4 4 4-4"/><path d="M5 17v3h14v-3"/>'),
};
