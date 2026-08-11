import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, num, numOrUndefined, parseEmbeddedJson, readJsonCapped } from './http.js';

/** A Response whose body streams the given chunks, no network involved. */
function streamed(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe('readJsonCapped', () => {
  it('parses a normal body', async () => {
    expect(await readJsonCapped(streamed(['{"a":', '1}']))).toEqual({ a: 1 });
  });

  it('refuses a body that streams past the cap', async () => {
    // Nothing declares its length here, so the only defence is counting bytes
    // while reading. An endpoint that streams forever would otherwise walk the
    // process into an out-of-memory kill.
    const big = 'x'.repeat(4096);
    await expect(readJsonCapped(streamed([big, big, big]), 4096)).rejects.toThrow(/exceeded/);
  });

  it('refuses on a declared length before reading a byte', async () => {
    await expect(
      readJsonCapped(streamed(['{}'], { 'content-length': '999999999' }), 1024),
    ).rejects.toThrow(/too large/);
  });

  it('trusts the stream over the header, because the header is only a claim', async () => {
    // Content-Length says this is small. It is not.
    const res = streamed(['y'.repeat(9000)], { 'content-length': '2' });
    await expect(readJsonCapped(res, 4096)).rejects.toThrow(/exceeded/);
  });

  it('joins chunks correctly when a character is split across them', async () => {
    // A multi-byte character landing on a chunk boundary must not be decoded
    // twice into two replacement characters.
    const encoder = new TextEncoder();
    const bytes = encoder.encode('{"s":"€"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    expect(await readJsonCapped(new Response(body))).toEqual({ s: '€' });
  });

  it('rejects invalid UTF-8 instead of replacing bytes inside JSON', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
        controller.close();
      },
    });
    await expect(readJsonCapped(new Response(body))).rejects.toThrow(/valid UTF-8/);
  });

  it('rejects an invalid cap before reading', async () => {
    await expect(readJsonCapped(streamed(['{}']), Number.MAX_VALUE)).rejects.toThrow(/positive safe integer/);
  });
});

describe('getJson retries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not redownload a deterministic malformed JSON response', async () => {
    const fetcher = vi.fn(async () => new Response('{broken', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(getJson('https://example.test/data', { retries: 3 })).rejects.toThrow(/valid JSON/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient server failure', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);

    await expect(getJson('https://example.test/data', { retries: 1 })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('caps a caller-supplied retry count', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => { throw new TypeError('offline'); });
    vi.stubGlobal('fetch', fetcher);

    const result = expect(getJson('https://example.test/data', { retries: 50 })).rejects.toThrow(/offline/);
    await vi.runAllTimersAsync();
    await result;
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});

describe('parseEmbeddedJson', () => {
  it('decodes the JSON Gamma ships inside a string', () => {
    expect(parseEmbeddedJson('["Yes","No"]', [])).toEqual(['Yes', 'No']);
  });

  it('returns the fallback rather than throwing on a malformed field', () => {
    // One broken field should cost a column, not the whole run.
    expect(parseEmbeddedJson('["Yes"', ['fallback'])).toEqual(['fallback']);
    expect(parseEmbeddedJson(undefined, [])).toEqual([]);
    expect(parseEmbeddedJson('null', ['x'])).toEqual(['x']);
  });

  it('passes an already decoded value straight through', () => {
    expect(parseEmbeddedJson(['Yes', 'No'], [])).toEqual(['Yes', 'No']);
  });
});

describe('num', () => {
  it('accepts the numbers and the numeric strings Gamma mixes', () => {
    expect(num(5)).toBe(5);
    expect(num('7.5')).toBe(7.5);
  });

  it('falls back rather than producing NaN', () => {
    expect(num('abc')).toBe(0);
    expect(num(Number.NaN)).toBe(0);
    expect(num(undefined, 3)).toBe(3);
  });
});

describe('numOrUndefined', () => {
  // The rule this enforces: Number(null) is 0, and 0 is a real outcome index,
  // a real payout and a real price. A fallback here turns an absent field into
  // a confident wrong answer, which is the subgraph bug in DNA.md.
  it('refuses to invent a zero', () => {
    expect(numOrUndefined(null)).toBeUndefined();
    expect(numOrUndefined(undefined)).toBeUndefined();
    expect(numOrUndefined('')).toBeUndefined();
    expect(numOrUndefined('   ')).toBeUndefined();
    expect(numOrUndefined({})).toBeUndefined();
  });

  it('keeps a real zero, which is the whole difficulty', () => {
    expect(numOrUndefined(0)).toBe(0);
    expect(numOrUndefined('0')).toBe(0);
  });

  it('takes Gamma numeric strings and rejects unparseable ones', () => {
    expect(numOrUndefined('1.5')).toBe(1.5);
    expect(numOrUndefined(2)).toBe(2);
    expect(numOrUndefined('abc')).toBeUndefined();
    expect(numOrUndefined(Number.NaN)).toBeUndefined();
    expect(numOrUndefined(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
