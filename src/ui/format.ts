/**
 * Formatting primitives, shared by the plain renderer and the TUI so both
 * surfaces round, truncate and colour identically.
 *
 * Inside the data table, colour still carries exactly one signal: the dispute
 * round count. Themes change what that ramp looks like and what the chrome
 * around it looks like. They do not add a second coloured meaning to a column.
 * A table where four things are coloured teaches the eye to ignore colour, and
 * then the one signal that mattered goes unread.
 */

import {
  bolden, colourise, detectDepth, invert, resolveTheme, type ColourDepth, type Theme,
} from './theme.js';

export interface Style {
  colour: boolean;
  width: number;
  theme: Theme;
  depth: ColourDepth;
}

/** Honour NO_COLOR, a non-TTY pipe, and an explicit override, in that order. */
export function detectStyle(opts: { colour?: boolean; width?: number; theme?: string } = {}): Style {
  const isTty = process.stdout.isTTY === true;
  const theme = resolveTheme(opts.theme);

  // Piping is not the same as asking for monochrome, but it is the same in
  // effect: escape codes in a file are noise, so the depth collapses to zero.
  const wanted = opts.colour ?? isTty;
  const depth = wanted ? detectDepth() : 0;

  return {
    colour: depth > 0,
    // COLUMNS wins when set so the behaviour can be tested without a terminal.
    width: opts.width ?? (Number(process.env.COLUMNS) || process.stdout.columns || 80),
    theme,
    depth,
  };
}

export const dim = (t: string, s: Style) => colourise(t, s.theme.dim, s.depth);
export const bold = (t: string, s: Style) => bolden(colourise(t, s.theme.accent, s.depth), s.depth);
export const accent = (t: string, s: Style) => colourise(t, s.theme.accent, s.depth);
export const body = (t: string, s: Style) => colourise(t, s.theme.text, s.depth);
export const selected = (t: string, s: Style) => invert(t, s.depth);

/** The one colour ramp in the tool: how many times a market was contested. */
export function paintRounds(rounds: number, text: string, style: Style): string {
  const hex = style.theme.ramp[rounds === 0 ? 0 : rounds === 1 ? 1 : 2]!;
  return colourise(text, hex, style.depth);
}

/** Compact money. Three significant figures is as much as anyone reads. */
export function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

/** Token counts, which run large and do not need a currency mark. */
export function count(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * A share as filled circles.
 *
 * Deliberately coarse: three buckets, not a percentage bar. The underlying
 * number is a share of a truncated holder list, and a fine-grained bar would
 * imply a precision the data does not have.
 */
export function meter(share: number): string {
  const filled = share >= 0.75 ? 3 : share >= 0.4 ? 2 : share > 0 ? 1 : 0;
  return '●'.repeat(filled) + '○'.repeat(3 - filled);
}

/**
 * Truncate to a visible width, marking that something was cut.
 *
 * Counts by code point rather than by UTF-16 unit. A market question containing
 * an astral character would otherwise be cut mid-surrogate, and half a
 * surrogate pair renders as a replacement box that also breaks the column it
 * was supposed to fit.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= 1) return chars.slice(0, width).join('');
  return `${chars.slice(0, width - 1).join('')}…`;
}

/** Visible width in cells, on the same code point basis as `clip`. */
export function widthOf(text: string): number {
  return [...text].length;
}

export function padEnd(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + ' '.repeat(Math.max(0, width - widthOf(clipped)));
}

export function padStart(text: string, width: number): string {
  const clipped = clip(text, width);
  return ' '.repeat(Math.max(0, width - widthOf(clipped))) + clipped;
}

/** Time remaining, or how long ago. Never a raw timestamp in a dense table. */
export function until(deadline: Date | undefined, now = new Date()): string {
  if (!deadline) return '—';

  const ms = deadline.getTime() - now.getTime();
  const past = ms < 0;
  const mins = Math.floor(Math.abs(ms) / 60_000);

  const text =
    mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;

  return past ? `-${text}` : text;
}

/** A horizontal rule that fits the terminal. */
export function rule(style: Style): string {
  return colourise('─'.repeat(Math.max(0, style.width)), style.theme.rule, style.depth);
}
