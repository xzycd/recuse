/**
 * Themes.
 *
 * The discipline from DNA.md still holds, and themes do not relax it: inside
 * the data table, colour carries exactly one signal, the dispute round count.
 * A theme changes what that ramp looks like and what the chrome around it looks
 * like. It never adds a second coloured meaning to a column.
 *
 * Everything is defined once, in hex, and consumed by both renderers. The plain
 * renderer converts to whatever escape depth the terminal admits to; ink takes
 * hex directly. Two colour tables would drift, and the whole point of a theme
 * is that the two surfaces look like the same program.
 */

export interface Theme {
  name: string;
  blurb: string;
  /** Brand: the wordmark, headings, the one thing that says which tool this is. */
  accent: string;
  text: string;
  dim: string;
  rule: string;
  /** The only ramp. Index 0 is never contested, 1 is once, 2 is more than once. */
  ramp: [string, string, string];
}

export const THEMES: Record<string, Theme> = {
  carbon: {
    name: 'carbon',
    blurb: 'near monochrome, one hot ramp. the default, and the one to read numbers in',
    accent: '#e8e6e3',
    text: '#d7d3ce',
    dim: '#6f6a65',
    rule: '#3a3531',
    ramp: ['#6f6a65', '#d9a441', '#e0533d'],
  },
  ember: {
    name: 'ember',
    blurb: 'warm, and the more contested a market is the more it looks on fire',
    accent: '#ffb454',
    text: '#f2e6d8',
    dim: '#8a6f52',
    rule: '#4a3826',
    ramp: ['#7a6650', '#ff9f1c', '#ff4d3d'],
  },
  signal: {
    name: 'signal',
    blurb: 'high contrast cyan and magenta, for terminals with a dark background',
    accent: '#7de2ff',
    text: '#dff3fb',
    dim: '#4c6a78',
    rule: '#22333c',
    ramp: ['#4c6a78', '#b06cff', '#ff3d81'],
  },
  moss: {
    name: 'moss',
    blurb: 'green phosphor, because someone always wants green phosphor',
    accent: '#7dff9b',
    text: '#cdf5d6',
    dim: '#4a7a58',
    rule: '#1e3626',
    ramp: ['#4a7a58', '#d7ff5c', '#ff6b4a'],
  },
  paper: {
    name: 'paper',
    blurb: 'muted ink for light terminals, where bright foregrounds disappear',
    accent: '#1f4b8f',
    text: '#2b2b2b',
    dim: '#767676',
    rule: '#c2c2c2',
    ramp: ['#767676', '#a8641c', '#b3241c'],
  },
};

export const DEFAULT_THEME = 'carbon';

/**
 * Resolve a theme name, falling back rather than failing.
 *
 * A typo in an environment variable should not stop someone reading a market.
 */
export function resolveTheme(name?: string): Theme {
  const key = (name ?? process.env.RECUSE_THEME ?? DEFAULT_THEME).trim().toLowerCase();
  return THEMES[key] ?? THEMES[DEFAULT_THEME]!;
}

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

/**
 * How much colour the terminal will actually accept.
 *
 * 0 means none. 16 is the original set, and is all a bare `TERM=xterm` promises.
 * 256 is the indexed cube. 24 means truecolor, where the hex values above
 * arrive intact.
 */
export type ColourDepth = 0 | 16 | 256 | 24;

export function detectDepth(env: NodeJS.ProcessEnv = process.env): ColourDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.FORCE_COLOR === '0') return 0;

  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 24;

  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'dumb') return 0;
  if (term.includes('256')) return 256;

  // iTerm, Apple Terminal and VS Code all set this and all do 24 bit, but only
  // some of them advertise COLORTERM.
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode') return 24;

  return term ? 16 : 0;
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

/** Map a colour into the 6x6x6 cube plus greyscale ramp of the 256 palette. */
function to256(hex: string): number {
  const [r, g, b] = toRgb(hex);

  // Greys land better on the dedicated 24 step ramp than in the colour cube.
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    const level = Math.round(((r + g + b) / 3 / 255) * 23);
    return 232 + Math.min(23, level);
  }

  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Nearest of the eight basic colours, bright when the source is light. */
function to16(hex: string): number {
  const [r, g, b] = toRgb(hex);
  const bright = Math.max(r, g, b) > 160;
  const bit = (v: number) => (v > 110 ? 1 : 0);
  const index = bit(r) + bit(g) * 2 + bit(b) * 4;
  return (bright ? 90 : 30) + index;
}

/** Wrap text in the escape for one colour at the depth the terminal supports. */
export function colourise(text: string, hex: string, depth: ColourDepth): string {
  if (depth === 0 || text.length === 0) return text;

  const open =
    depth === 24
      ? `[38;2;${toRgb(hex).join(';')}m`
      : depth === 256
        ? `[38;5;${to256(hex)}m`
        : `[${to16(hex)}m`;

  return `${open}${text}[39m`;
}

export function bolden(text: string, depth: ColourDepth): string {
  return depth === 0 ? text : `[1m${text}[22m`;
}

export function invert(text: string, depth: ColourDepth): string {
  return depth === 0 ? text : `[7m${text}[27m`;
}
