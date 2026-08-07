/**
 * The wordmark.
 *
 * Three rows of half blocks. U+2580, U+2584 and U+2588 are in every monospace
 * font shipped with a terminal, unlike the quadrant and eighth blocks that
 * fancier ASCII art reaches for, which fall back to boxes on enough machines to
 * matter. The same letterform grid is used to generate the SVG in assets/, so
 * the README and the terminal are drawing the same shapes.
 *
 * No emoji, per DNA.md, and nothing here is wider than 29 columns, so it
 * survives an 80 column terminal with room to spare.
 */

import { bolden, colourise, type ColourDepth, type Theme } from './theme.js';

export const WORDMARK = [
  '█▀▀█ █▀▀▀ █▀▀▀ █  █ █▀▀▀ █▀▀▀',
  '█▀▀▄ █▀▀  █    █  █ ▀▀▀█ █▀▀ ',
  '▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
] as const;

export const WORDMARK_WIDTH = 29;

/** What the tool is, in one line, for directly under the wordmark. */
export const TAGLINE = 'who decided this market, and what did they own';

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
 * Below 34 columns the wordmark would wrap into nonsense, so it collapses to a
 * single line. Wrapping a logo is worse than not drawing one.
 */
export function splash(opts: SplashOptions): string {
  const { theme, depth, width, version, hint } = opts;
  const accent = (t: string) => colourise(t, theme.accent, depth);
  const dim = (t: string) => colourise(t, theme.dim, depth);

  if (width < WORDMARK_WIDTH + 5) {
    return `${bolden(accent('recuse'), depth)} ${dim(`v${version}`)}`;
  }

  const lines = WORDMARK.map((row) => `  ${accent(row)}`);

  // The version sits on the last row of the wordmark, right of the letters,
  // where it reads as a build stamp rather than as another line of chrome.
  lines[2] = `  ${accent(WORDMARK[2])}  ${dim(`v${version}`)}`;

  const out = [...lines, `  ${dim(TAGLINE)}`];
  if (hint) out.push('', `  ${dim(hint)}`);

  return out.join('\n');
}

/** One line, for headers and for anywhere the full banner would be noise. */
export function mark(theme: Theme, depth: ColourDepth): string {
  return bolden(colourise('recuse', theme.accent, depth), depth);
}
