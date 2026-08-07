/**
 * Formatting primitives, shared by the plain renderer and the TUI so both
 * surfaces round, truncate and colour identically.
 *
 * Colour is spent on one thing: the dispute round count. Everything else is
 * monochrome. A table where four columns are coloured teaches the eye to
 * ignore colour, and then the one signal that mattered goes unread.
 */

const ESC = '[';

export interface Style {
  colour: boolean;
  width: number;
}

/** Honour NO_COLOR, a non-TTY pipe, and an explicit override, in that order. */
export function detectStyle(opts: { colour?: boolean; width?: number } = {}): Style {
  const isTty = process.stdout.isTTY === true;
  const noColour = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';

  return {
    colour: opts.colour ?? (isTty && !noColour),
    // COLUMNS wins when set so the behaviour can be tested without a terminal.
    width: opts.width ?? (Number(process.env.COLUMNS) || process.stdout.columns || 80),
  };
}

const CODES = {
  reset: '0',
  dim: '2',
  bold: '1',
  red: '31',
  yellow: '33',
  green: '32',
  cyan: '36',
} as const;

export function paint(text: string, code: keyof typeof CODES, style: Style): string {
  if (!style.colour) return text;
  return `${ESC}${CODES[code]}m${text}${ESC}${CODES.reset}m`;
}

export const dim = (t: string, s: Style) => paint(t, 'dim', s);
export const bold = (t: string, s: Style) => paint(t, 'bold', s);

/** The one colour ramp in the tool: how many times a market was contested. */
export function paintRounds(rounds: number, text: string, style: Style): string {
  if (rounds === 0) return dim(text, style);
  if (rounds === 1) return paint(text, 'yellow', style);
  return paint(text, 'red', style);
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

/** Truncate to a visible width, marking that something was cut. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

export function padEnd(text: string, width: number): string {
  return clip(text, width).padEnd(width);
}

export function padStart(text: string, width: number): string {
  return clip(text, width).padStart(width);
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
  return dim('─'.repeat(Math.max(0, style.width)), style);
}
