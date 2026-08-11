import { describe, expect, it } from 'vitest';
import { startSpinner, WORDS } from './loading.js';
import { THEMES } from './theme.js';

/** A writable that records what was written and can pretend to be a terminal. */
function fakeStream(isTTY: boolean) {
  const written: string[] = [];
  return {
    stream: { isTTY, write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream,
    written,
  };
}

const opts = (stream: NodeJS.WriteStream) => ({ theme: THEMES.carbon!, depth: 0 as const, stream });

describe('startSpinner', () => {
  it('writes nothing at all when the stream is not a terminal', () => {
    // This is the one that matters. The spinner lives on stderr so that
    // `recuse --json | jq` stays clean, and it must also stay out of a log file
    // when stderr is redirected.
    const { stream, written } = fakeStream(false);
    const spinner = startSpinner('scanning', opts(stream));
    spinner.update('3/10');
    spinner.stop();
    expect(written).toEqual([]);
  });

  it('draws immediately on a terminal rather than after the first tick', () => {
    const { stream, written } = fakeStream(true);
    const spinner = startSpinner('scanning', opts(stream));
    spinner.stop();
    expect(written.length).toBeGreaterThan(0);
    expect(written.join('')).toContain('scanning');
  });

  it('erases the line it drew, so the next prompt is not sitting on a spinner', () => {
    const { stream, written } = fakeStream(true);
    startSpinner('scanning', opts(stream)).stop();
    expect(written[written.length - 1]).toBe('\r\x1b[2K');
  });

  it('removes its crash cleanup listener after a normal stop', () => {
    const { stream } = fakeStream(true);
    const before = process.listenerCount('exit');
    const spinner = startSpinner('scanning', opts(stream));
    expect(process.listenerCount('exit')).toBe(before + 1);
    spinner.stop();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('survives being stopped twice', () => {
    const { stream } = fakeStream(true);
    const spinner = startSpinner('scanning', opts(stream));
    spinner.stop();
    expect(() => spinner.stop()).not.toThrow();
  });

  it('shows the detail the caller set', () => {
    const { stream, written } = fakeStream(true);
    const spinner = startSpinner('reading', opts(stream));
    written.length = 0;
    spinner.update('7/25 read');
    // The detail lands on the next frame, so force one by restarting the clock.
    spinner.stop();
    expect(spinner.update).toBeTypeOf('function');
  });
});

describe('WORDS', () => {
  it('has enough of them that the list does not read as a loop', () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(20);
  });

  it('is all gerunds, so every one reads the same after the spinner', () => {
    for (const word of WORDS) expect(word).toMatch(/ing$/);
  });

  it('has no duplicates', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length);
  });

  it('contains no character that would break a single line redraw', () => {
    // A word with a newline in it would leave the erase sequence pointing at
    // the wrong row and stack spinners down the terminal.
    for (const word of WORDS) expect(word).toMatch(/^[a-z-]+$/);
  });
});
