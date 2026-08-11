/**
 * The wordmark and the face.
 *
 * Three rows of half blocks for the letters. U+2580, U+2584 and U+2588 are in
 * every monospace font shipped with a terminal, unlike the quadrant and eighth
 * blocks that fancier ASCII art reaches for, which fall back to boxes on enough
 * machines to matter. The same letterform grid generates the SVG in assets/, so
 * the README and the terminal are drawing the same shapes.
 *
 * The eyes are the ASCII letter x rather than a box-drawing cross. U+2573 looks
 * better and is East Asian Width "ambiguous", which means it renders double
 * width under a CJK locale and shears the whole banner. Every other glyph here
 * is unambiguously single width.
 *
 * DNA.md bans emoji, and this is not one: it is drawn, so it occupies exactly
 * the cells it says it does. That is the property the ban is protecting.
 */

import { bolden, colourise, type ColourDepth, type Theme } from './theme.js';

export const WORDMARK = [
  '█▀▀█ █▀▀▀ █▀▀▀ █  █ █▀▀▀ █▀▀▀',
  '█▀▀▄ █▀▀  █    █  █ ▀▀▀█ █▀▀ ',
  '▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
] as const;

export const WORDMARK_WIDTH = 29;

/**
 * X eyes, because that is what this tool measures.
 *
 * A settled market's losing side is worth nothing, and X eyes are the universal
 * shorthand for exactly that. Deliberately lopsided: the eyes are not evenly
 * spaced, and a symmetrical version reads as a stock icon rather than as
 * something a person drew.
 */
export const FACE = [
  ' ▄▀▀▀▀▀▄ ',
  '█ x    x█',
  '█ ▀▄▄▄▀ █',
  ' ▀▄▄▄▄▄▀ ',
] as const;

export const FACE_WIDTH = 9;

/** What the tool is, in one line, for directly under the wordmark. */
export const TAGLINE = 'rebuild what settlement erased';

/** Below this the face is dropped, below WORDMARK_WIDTH + 5 so is the wordmark. */
const FACE_MIN_WIDTH = FACE_WIDTH + 2 + TAGLINE.length + 2;

export interface SplashOptions {
  theme: Theme;
  depth: ColourDepth;
  width: number;
  version: string;
  /** Shown dim on the last line. Skipped when empty. */
  hint?: string;
}

/**
 * The launch banner.
 *
 * Four rows: three of wordmark and one of tagline, which is exactly the height
 * of the face, so the two sit beside each other without padding either. Below
 * 34 columns the wordmark would wrap into nonsense, so it collapses to a single
 * line. Wrapping a logo is worse than not drawing one.
 */
export function splash(opts: SplashOptions): string {
  const { theme, depth, width, version, hint } = opts;
  const accent = (t: string) => colourise(t, theme.accent, depth);
  const dim = (t: string) => colourise(t, theme.dim, depth);
  // The face carries the warm end of the ramp, the same colour a heavily
  // contested market gets. It is the only warm thing on the screen at rest.
  const warm = (t: string) => colourise(t, theme.ramp[1], depth);

  if (width < WORDMARK_WIDTH + 5) {
    return `${bolden(accent('recuse'), depth)} ${dim(`v${version}`)}`;
  }

  const right = [
    accent(WORDMARK[0]),
    accent(WORDMARK[1]),
    `${accent(WORDMARK[2])}  ${dim(`v${version}`)}`,
    dim(TAGLINE),
  ];

  const lines =
    width >= FACE_MIN_WIDTH
      ? right.map((row, i) => `  ${warm(FACE[i]!)}  ${row}`)
      : right.map((row) => `  ${row}`);

  const out = [...lines];
  if (hint) out.push('', `  ${dim(hint)}`);

  return out.join('\n');
}

/** One line, for headers and for anywhere the full banner would be noise. */
export function mark(theme: Theme, depth: ColourDepth): string {
  return bolden(colourise('recuse', theme.accent, depth), depth);
}
