import type { ProfileColor } from '@playzin/shared';

/**
 * Tema do menu por perfil: a cor de destaque (foco, barras, botões) segue a cor do perfil ativo.
 * accent = destaque, accent2 = versão clara (títulos em foco), ink = texto sobre o destaque.
 */
export const THEMES: Record<ProfileColor, { accent: string; accent2: string; ink: string }> = {
  coral: { accent: '#ff8a5c', accent2: '#ffb291', ink: '#3a1300' },
  ocean: { accent: '#00c8f0', accent2: '#5ae0ff', ink: '#00222b' },
  forest: { accent: '#3fd27a', accent2: '#84e8ab', ink: '#032611' },
  grape: { accent: '#b27cff', accent2: '#d0aaff', ink: '#1e0844' },
  sunny: { accent: '#ffc531', accent2: '#ffdb7a', ink: '#3a2700' },
  mint: { accent: '#3fe6c8', accent2: '#8bf2e0', ink: '#032a24' },
  rose: { accent: '#ff6fae', accent2: '#ffa3cc', ink: '#3d0620' },
  slate: { accent: '#9fb3cf', accent2: '#c6d3e4', ink: '#1a2230' },
};

/** Tema de antes dos perfis (e de quando ninguém está jogando). */
export const DEFAULT_THEME: ProfileColor = 'ocean';

/** Lembrado no navegador para a abertura já nascer com a cor de quem jogou por último. */
const THEME_KEY = 'playzin:launcher:theme';

let current: ProfileColor | null = null;

/** Aplica o tema na página inteira (menu, teclado virtual, telas de perfil, carregando). */
export function applyTheme(color: ProfileColor | null | undefined): void {
  const name = color && color in THEMES ? color : DEFAULT_THEME;
  if (name === current) return;
  // A primeira cor entra direto (sem degradê a partir do azul padrão).
  if (current === null) {
    document.documentElement.classList.add('theme-instant');
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('theme-instant')));
  }
  current = name;
  const theme = THEMES[name];
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent-2', theme.accent2);
  root.setProperty('--accent-ink', theme.ink);
  document.documentElement.dataset.theme = name;
}

/** Tema do perfil ativo: aplica e lembra para o próximo boot. */
export function setProfileTheme(color: ProfileColor | null | undefined): void {
  applyTheme(color);
  try {
    if (color) localStorage.setItem(THEME_KEY, color);
  } catch {
    /* sem localStorage */
  }
}

/** Chamado logo ao abrir o launcher, antes da abertura. */
export function restoreTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* sem localStorage */
  }
  applyTheme(saved as ProfileColor | null);
}
