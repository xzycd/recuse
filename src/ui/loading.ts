/**
 * The spinner.
 *
 * A radar scan walks several hundred markets and then reads holders for each
 * one, sequentially and on purpose, so it takes seconds. Seconds of nothing
 * reads as a hang. This says what is happening and keeps saying it.
 *
 * Three rules it does not break:
 *
 * Everything goes to stderr. `recuse --json | jq` has to stay clean, and a
 * spinner on stdout would be inside the pipe.
 *
 * Nothing draws unless stderr is a terminal. Redirected to a file, the carriage
 * returns would pile up into a wall of half-overwritten lines.
 *
 * It always clears the line it drew. A process that exits mid-frame leaves the
 * user's next prompt sitting on top of a spinner.
 */

import { colourise, type ColourDepth, type Theme } from './theme.js';

/**
 * What it claims to be doing.
 *
 * Half of these are honest and half are not, which is the joke. The honest ones
 * are drawn from the domain the tool actually works in, so even the filler
 * reads like this program and not like a generic CLI.
 */
export const WORDS = [
  'vibing',
  'cameralizing',
  'sleuthing',
  'subpoenaing',
  'cross-examining',
  'deposing',
  'gavelling',
  'recusing',
  'unsealing',
  'redacting',
  'impounding',
  'arraigning',
  'triangulating',
  'tallying',
  'sifting',
  'dredging',
  'unmasking',
  'percolating',
  'marinating',
  'brooding',
  'divining',
  'auguring',
  'skulking',
  'prying',
  'decanting',
  'prospecting',
  'scheming',
  'doomscrolling',
  'whalewatching',
  'blockcrawling',
  'mempooling',
  'nonce-hunting',
  'bagholding',
  'moonmathing',
  'degenning',
  'coping',
  'seething',
  'oracling',
  'shadowing',
  'stakeouting',
] as const;

/** Braille dots. Eight frames, one cell wide, and they do not shift the line. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'] as const;

const FRAME_MS = 90;
/** How long one word stays up. Faster than this and it reads as flicker. */
const WORD_MS = 1400;

export interface SpinnerOptions {
  theme: Theme;
  depth: ColourDepth;
  /** Overridden in tests. Anything not a TTY gets a silent spinner. */
  stream?: NodeJS.WriteStream;
  /** Fixed word order, for tests. Random when absent. */
  words?: readonly string[];
}

export interface Spinner {
  /** Replace the trailing detail, e.g. how many markets have been read. */
  update(detail: string): void;
  /** Erase the line and stop. Safe to call twice. */
  stop(): void;
}

/** A spinner that draws nothing, for pipes, --json, and NO_COLOR-free scripts. */
const SILENT: Spinner = { update() {}, stop() {} };

export function startSpinner(label: string, opts: SpinnerOptions): Spinner {
  const stream = opts.stream ?? process.stderr;
  if (stream.isTTY !== true) return SILENT;

  const words = opts.words ?? WORDS;
  const started = Date.now();
  let detail = '';
  let frame = 0;
  let stopped = false;

  // Chosen per tick from the elapsed time rather than held in a counter, so the
  // word changes on a wall-clock cadence instead of a render one.
  const wordAt = (elapsed: number) => {
    const slot = Math.floor(elapsed / WORD_MS);
    // A cheap deterministic shuffle. Consecutive slots land far apart in the
    // list, so it does not read as a loop through an alphabetical menu.
    return words[(slot * 7 + started) % words.length] ?? words[0]!;
  };

  const clear = () => {
    // Return to column zero, erase to end of line. No cursor save or restore,
    // which some terminals honour and some quietly drop.
    stream.write('\r[2K');
  };

  const draw = () => {
    if (stopped) return;
    const elapsed = Date.now() - started;
    const secs = (elapsed / 1000).toFixed(1);
    const spin = colourise(FRAMES[frame % FRAMES.length]!, opts.theme.accent, opts.depth);
    const word = colourise(`${wordAt(elapsed)}…`, opts.theme.text, opts.depth);
    const tail = colourise(
      `${label}${detail ? ` ${detail}` : ''} ${secs}s`,
      opts.theme.dim,
      opts.depth,
    );

    clear();
    stream.write(`${spin} ${word} ${tail}`);
    frame += 1;
  };

  draw();
  const timer = setInterval(draw, FRAME_MS);
  // Without this the interval alone keeps the event loop alive and the process
  // never exits on its own.
  timer.unref?.();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clear();
  };

  // A crash between start and stop would otherwise leave the terminal holding a
  // half-drawn line with no newline after it.
  process.once('exit', stop);

  return {
    update(next: string) {
      detail = next;
    },
    stop,
  };
}
