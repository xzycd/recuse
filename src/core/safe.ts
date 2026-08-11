/**
 * Making remote text safe to put on a terminal.
 *
 * This is not paranoia for its own sake. Polymarket display names are chosen by
 * the account holder, and this tool prints them next to claims about that
 * account's behaviour. A wallet that can write escape sequences into a name can
 * do a lot more than break a column:
 *
 *   \x1b[2J\x1b[H      clears the screen and homes the cursor, so the attacker
 *                      can redraw the table above them and forge a whole report
 *   \r                 returns to column zero, overwriting the row just printed
 *   \x1b]52;c;<b64>\x07  writes the user's clipboard on xterm, iTerm2 and kitty
 *   \x1b]0;text\x07    rewrites the terminal title
 *   U+202E             right-to-left override, so 0xdeadbeef renders reversed
 *   U+200B             zero width space, so two different addresses look equal
 *
 * The last two matter most here. Every finding this tool reports is anchored to
 * an address, and a tool whose whole claim is "here is the record" cannot let a
 * subject of that record edit how it renders.
 *
 * Sanitising happens on ingest, in the source modules, not at render time. A
 * render-time filter is one forgotten call site away from a hole, and it would
 * leave --json output dirty while the table looked clean.
 */

/**
 * Characters that never legitimately appear in a market question or a chosen
 * display name, and that change what a terminal does when they arrive.
 *
 * Built as an explicit allow-deny on code points rather than a regex over
 * escape-sequence grammar. Escape grammars are large, terminal-specific and
 * still growing; the set of control characters is fixed and small.
 */
function isUnsafeCodePoint(cp: number): boolean {
  // C0 controls and DEL. Includes ESC (0x1b), CR (0x0d), BEL (0x07).
  if (cp <= 0x1f || cp === 0x7f) return true;
  // C1 controls. Some terminals honour these as single-byte CSI and OSC.
  if (cp >= 0x80 && cp <= 0x9f) return true;
  // Zero width space, joiner, non-joiner, and the LTR/RTL marks.
  if (cp >= 0x200b && cp <= 0x200f) return true;
  // Arabic letter mark, another invisible bidirectional control.
  if (cp === 0x061c) return true;
  // Bidirectional embedding and override.
  if (cp >= 0x202a && cp <= 0x202e) return true;
  // Word joiner, bidirectional isolates, and deprecated directional controls.
  if (cp >= 0x2060 && cp <= 0x206f) return true;
  // Byte order mark used mid-string, and the interlinear annotation set.
  if (cp === 0xfeff || (cp >= 0xfff9 && cp <= 0xfffb)) return true;
  // Variation selectors and tag characters, both invisible and both usable to
  // smuggle payloads through anything that compares displayed text.
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return false;
}

// Unicode adds invisible formatting characters outside the hand-written
// ranges above. Default_Ignorable_Code_Point covers soft hyphens, combining
// grapheme joiners, supplementary variation selectors and future additions.
// Node 22 is the runtime floor, so this binary property is available anywhere
// the package runs.
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/** Longest remote string we will keep. Anything past this is padding or attack. */
const MAX_TEXT = 300;

/**
 * Strip anything a terminal would act on, collapse whitespace, and cap length.
 *
 * Removes rather than escapes. An escaped control character shown as `^[` is
 * still noise in a dense table, and nobody reading a market question needs to
 * know that someone tried.
 */
export function safeText(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length === 0) return '';

  // Cut before walking, not after. The loop below is per code point, and a
  // remote that answers with a megabyte in a name field should cost a slice
  // rather than a million iterations. Four UTF-16 units per code point is the
  // worst case, plus slack, so nothing legitimate is ever reached by this.
  const bounded = value.length > max * 8 ? value.slice(0, max * 8) : value;

  let out = '';
  // Iterating by code point, not by UTF-16 unit, so astral characters survive
  // intact instead of being split into lone surrogates.
  for (const ch of bounded) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isUnsafeCodePoint(cp) || DEFAULT_IGNORABLE.test(ch)) {
      // Tabs and newlines are real whitespace in the source data even though
      // they are control characters, so they become a space rather than
      // vanishing and gluing two words together.
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' ';
      continue;
    }
    out += ch;
  }

  out = out.replace(/\s+/g, ' ').trim();

  // The walk above is by code point, so the final cap has to be as well. A
  // UTF-16 slice can cut an astral character into a lone surrogate exactly at
  // the boundary, which then changes again when JSON serialises it.
  const points = [...out];
  return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join('')}…` : out;
}

/**
 * A 0x-prefixed hex address, lowercased, or undefined.
 *
 * Addresses are printed as identity and used to join records across sources, so
 * a malformed one is dropped rather than passed along. Accepting "close enough"
 * here is how two different accounts end up sharing a row.
 */
export function safeAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : undefined;
}

/** A 32-byte condition or question id, lowercased, or undefined. */
export function safeHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * A CLOB token id: an unsigned decimal integer up to 78 digits.
 *
 * These are interpolated into GraphQL queries, so the shape is checked rather
 * than trusted. Bounded length also keeps a hostile value from turning into a
 * multi-megabyte query body.
 */
export function safeTokenId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[0-9]{1,78}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Remove credentials from a URL before it can reach a log line or an error.
 *
 * RECUSE_RPC_URL usually carries an API key, either as a path segment
 * (`.../v2/<key>`) or as a query parameter. Node's fetch puts the full URL in
 * the message of some network errors, and this tool prints error messages. A
 * user pasting a stack trace into a bug report should not be handing over their
 * endpoint along with it.
 */
export function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (url.username || url.password) {
    url.username = 'redacted';
    url.password = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    url.searchParams.set(key, 'redacted');
  }

  // Any path segment long enough and opaque enough to be a key is treated as
  // one. Provider URLs put the key last and nothing else there looks like this.
  const segments = url.pathname.split('/').map((seg) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // A malformed escape stays as text and is tested by the conservative
      // opaque-segment rule below.
    }
    // Error messages often put a closing parenthesis or full stop directly
    // after a URL. Treat trailing punctuation as part of a secret-bearing
    // segment rather than letting it defeat an anchored key check.
    const trailing = '(?:[^A-Za-z0-9_-].*)?';
    const opaque = new RegExp(`^[A-Za-z0-9_-]{20,}${trailing}$`).test(decoded);
    const telegramBot = new RegExp(`^bot\\d{5,}:[A-Za-z0-9_-]{15,}${trailing}$`).test(decoded);
    return opaque || telegramBot ? 'redacted' : seg;
  });
  url.pathname = segments.join('/');
  if (url.hash) url.hash = '#redacted';

  return url.toString();
}

/** Scrub every URL-shaped substring out of arbitrary error text. */
export function redactMessage(message: string): string {
  const redacted = message.replace(/https?:\/\/[^\s'"]+/gi, (match) => redactUrl(match));
  // Error text can come from a remote JSON body too. It reaches stderr, MCP
  // and caveats, so credentials and terminal controls have to be removed at
  // the same boundary.
  return safeText(redacted, 1000);
}

/**
 * Accept an endpoint only if it is one we are willing to send a POST to.
 *
 * Without this, RECUSE_RPC_URL is an arbitrary URL that the tool will read a
 * JSON body from. `file:` would turn a config value into a local file read.
 */
export function safeEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('endpoint is not a valid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`endpoint must be http or https, got ${url.protocol}`);
  }

  return url;
}
