import { describe, expect, it } from 'vitest';
import { num, parseEmbeddedJson, readJsonCapped } from './http.js';

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
