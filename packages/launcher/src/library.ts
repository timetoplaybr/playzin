import type { CartridgeInfo, CartridgeManifest } from '@playzin/shared';

/** Um jogo que já passou pelo console (mesmo que o cartucho não esteja inserido agora). */
export interface LibraryEntry {
  id: string;
  name: string;
  version: string;
  /** Do playzin.json, para a página de detalhes funcionar sem o cartucho. */
  description?: string;
  author?: string;
  players?: CartridgeManifest['players'];
  /** O jogo tem arte de fundo (o console guarda a cópia: /api/backgrounds/<id>). */
  background?: boolean;
  /** Capa guardada como data URL, para aparecer mesmo sem o cartucho. */
  cover?: string;
  lastSeen: number;
  lastPlayed?: number;
}

const STORAGE_KEY = 'playzin:launcher:library';
const MAX_ENTRIES = 24;
const MAX_COVER_BYTES = 400_000;

/**
 * Biblioteca de jogos conhecidos, como a fileira de jogos de um console:
 * o cartucho inserido aparece primeiro, e os que já foram jogados ficam
 * logo depois (esmaecidos, pedindo para inserir o cartucho).
 */
export class Library {
  private entries = new Map<string, LibraryEntry>();
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      for (const entry of raw ? (JSON.parse(raw) as LibraryEntry[]) : []) this.entries.set(entry.id, entry);
    } catch {
      /* biblioteca corrompida ou storage indisponível: começa vazia */
    }
  }

  /** Mais recentes primeiro. */
  list(): LibraryEntry[] {
    return [...this.entries.values()].sort(
      (a, b) => (b.lastPlayed ?? b.lastSeen) - (a.lastPlayed ?? a.lastSeen),
    );
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.get(id);
  }

  /** Registra o cartucho inserido e guarda uma cópia da capa. */
  async remember(cartridge: CartridgeInfo): Promise<void> {
    const { manifest } = cartridge;
    const previous = this.entries.get(manifest.id);
    const entry: LibraryEntry = {
      ...previous,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      players: manifest.players,
      background: Boolean(cartridge.hasBackground),
      lastSeen: Date.now(),
    };
    this.entries.set(manifest.id, entry);
    this.save();

    if (cartridge.coverUrl) {
      const cover = await fetchAsDataUrl(cartridge.coverUrl);
      if (cover) {
        entry.cover = cover;
        this.save();
      }
    }
  }

  markPlayed(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.lastPlayed = Date.now();
    this.save();
  }

  forget(id: string): void {
    this.entries.delete(id);
    this.save();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save(): void {
    const list = this.list().slice(0, MAX_ENTRIES);
    this.entries = new Map(list.map((e) => [e.id, e]));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      // Storage cheio: tenta de novo sem as capas.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(({ cover: _c, ...rest }) => rest)));
      } catch {
        /* desiste em silêncio */
      }
    }
    this.listeners.forEach((l) => l());
  }
}

async function fetchAsDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    if (blob.size > MAX_COVER_BYTES || !blob.type.startsWith('image/')) return undefined;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}
