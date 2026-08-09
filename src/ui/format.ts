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

/** `0x614f…3b8a`. Enough to recognise, and to check against a full one. */
export function shortAddress(address: string): string {
  return address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * A display name worth printing beside an address.
 *
 * Polymarket defaults an account's display name to its own address, and plenty
 * of accounts never change it. So a name column fills up with entries like
 * `0x7Ee7B7fe80641bE006601Fce0D43D0CD0A551…`, which is the anchor column
 * repeated, in the wrong case, clipped to a width that makes it uncheckable.
 * That is precisely the identifier failure `label` below exists to refuse,
 * arriving through the one field the account controls.
 *
 * A name that is the row's own address is dropped, because the anchor already
 * carries it and the row is not named. A name that is some other address is
 * kept, since an account calling itself by an address that is not its own is
 * worth seeing, and shortened, so what is shown can be checked against
 * something rather than trailing off mid identifier.
 */
export function displayName(name: string | undefined, address: string): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;

  // The data API serves some of these already truncated, ellipsis included:
  // `0x7Ee7B7fe80641bE006601Fce0D43D0CD0A551…` arrives at 40 characters for a
  // 42 character address. So the fragment is not equal to the address and not
  // the length of one, and a check for either misses every real case.
  const bare = trimmed.replace(/(?:…|\.\.\.)$/, '');
  if (!/^0x[0-9a-f]{4,40}$/i.test(bare)) return trimmed;

  // A prefix of the row's own address, at whatever length it was cut to, is the
  // account not having chosen a name.
  if (address.trim().toLowerCase().startsWith(bare.toLowerCase())) return undefined;

  // Some other address. Worth seeing, and shortened when it is whole so it can
  // be read against the anchor beside it.
  return bare.length === 42 ? shortAddress(bare) : trimmed;
}

/**
 * Label a wallet in a fixed width column.
 *
 * Two rules, both load bearing.
 *
 * A name never appears without an address. Display names are chosen by the
 * account, nothing stops one from calling itself `0xdead…beef` or `Polymarket`,
 * and every finding in this tool is anchored to an address. A table showing
 * names alone would let its own subjects decide who they appear to be.
 *
 * Shortening is all or nothing across a column. Handing a 42 character address
 * to a 28 cell column produces `0x971f91a412236cc942a6f4485…`, which reads like
 * an identifier and cannot be checked against anything. Either every row is
 * full or every row is abbreviated the same way, and the full form is always in
 * `--json`.
 */
export function label(
  name: string | undefined,
  address: string,
  width: number,
  short: boolean,
): string {
  if (!short) return address;

  const tail = shortAddress(address);
  const shown = displayName(name, address);
  if (!shown) return tail;

  const room = width - widthOf(tail) - 1;
  return room >= 4 ? `${clip(shown, room)} ${tail}` : tail;
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
