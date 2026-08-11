import { describe, expect, it } from 'vitest';
import {
  redactMessage, redactUrl, safeAddress, safeEndpoint, safeHash, safeText, safeTokenId,
} from './safe.js';

describe('safeText', () => {
  it('strips the escape sequence that would let a name redraw the table', () => {
    // A display name is chosen by the account. This one clears the screen and
    // homes the cursor, which would let the wallet forge every row above it.
    const attack = '[2J[Hwhale';
    expect(safeText(attack)).toBe('[2J[Hwhale');
    // Idempotent, which is the stronger claim: a second pass finds nothing to
    // strip, so the first one did not leave a fragment behind that a later
    // concatenation could reassemble into an escape.
    expect(safeText(safeText(attack))).toBe(safeText(attack));
  });

  it('strips a carriage return, which overwrites the row already printed', () => {
    expect(safeText('honest\rLIQUIDATED')).toBe('honest LIQUIDATED');
  });

  it('strips the OSC clipboard write', () => {
    expect(safeText(']52;c;cm0gLXJmIH4=alice')).toBe(']52;c;cm0gLXJmIH4=alice');
  });

  it('strips the right-to-left override that reverses a rendered address', () => {
    expect(safeText('safe‮gnirts')).toBe('safegnirts');
  });

  it('strips zero width characters that make two names look identical', () => {
    const a = safeText('whale​watcher');
    const b = safeText('whalewatcher');
    expect(a).toBe(b);
  });

  it('strips directional isolates and Arabic letter marks too', () => {
    expect(safeText('a\u061cb\u2066c\u2069d')).toBe('abcd');
  });

  it('strips default-ignorable characters outside the explicit ranges', () => {
    // Soft hyphen, combining grapheme joiner and a supplementary variation
    // selector all render invisibly and can make distinct names look equal.
    expect(safeText('a\u00adb\u034fc\u{E0100}d')).toBe('abcd');
  });

  it('keeps tabs and newlines as spaces rather than gluing words together', () => {
    expect(safeText('two\twords\nhere')).toBe('two words here');
  });

  it('keeps ordinary text and emoji intact without splitting surrogates', () => {
    expect(safeText('Will Zelenskyy wear a suit before July?')).toBe(
      'Will Zelenskyy wear a suit before July?',
    );
    expect(safeText('a\u{1F600}b')).toBe('a\u{1F600}b');
  });

  it('caps length so one row cannot push the table off screen', () => {
    const out = safeText('x'.repeat(5000));
    expect(out.length).toBe(300);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never cuts an astral character into an invalid surrogate at the cap', () => {
    const out = safeText(`a\u{1F600}b`, 3);
    expect(out).toBe('a\u{1F600}b');
    expect(safeText(`aa\u{1F600}b`, 3)).toBe('aa…');
  });

  it('returns empty for anything that is not a string', () => {
    expect(safeText(undefined)).toBe('');
    expect(safeText(42)).toBe('');
    expect(safeText({ toString: () => 'nope' })).toBe('');
  });
});

describe('safeAddress and safeHash', () => {
  it('accepts a well formed address and lowercases it', () => {
    expect(safeAddress('0x' + 'AB'.repeat(20))).toBe('0x' + 'ab'.repeat(20));
  });

  it('rejects anything the wrong length, so two accounts cannot share a row', () => {
    expect(safeAddress('0xabc')).toBeUndefined();
    expect(safeAddress('0x' + 'a'.repeat(41))).toBeUndefined();
    expect(safeAddress('not an address')).toBeUndefined();
  });

  it('rejects a hash that is not 32 bytes', () => {
    expect(safeHash('0x' + 'a'.repeat(64))).toBe('0x' + 'a'.repeat(64));
    expect(safeHash('0x' + 'a'.repeat(63))).toBeUndefined();
  });
});

describe('safeTokenId', () => {
  it('accepts the long decimal integers Polymarket uses', () => {
    expect(safeTokenId('34379581789895528560281218239759280237277305372978794324822777438824410172683'))
      .toBe('34379581789895528560281218239759280237277305372978794324822777438824410172683');
  });

  it('rejects anything that could close a GraphQL string and add a clause', () => {
    expect(safeTokenId('1" } ) { __schema { types { name } } } #')).toBeUndefined();
    expect(safeTokenId('0x123')).toBeUndefined();
    expect(safeTokenId('12 34')).toBeUndefined();
    expect(safeTokenId('9'.repeat(79))).toBeUndefined();
  });
});

describe('redactUrl', () => {
  it('removes an API key carried as the last path segment', () => {
    expect(redactUrl('https://polygon-mainnet.g.alchemy.com/v2/AbCdEf0123456789xyzQQ'))
      .toBe('https://polygon-mainnet.g.alchemy.com/v2/redacted');
  });

  it('removes an API key carried as a query parameter', () => {
    expect(redactUrl('https://rpc.example.com/?apiKey=secret123')).toContain('apiKey=redacted');
  });

  it('removes a Telegram bot token whose colon makes it unlike a plain API key', () => {
    const url = 'https://api.telegram.org/bot123456789:AAExampleToken_123456789/sendMessage';
    const redacted = redactUrl(url);
    expect(redacted).toBe('https://api.telegram.org/redacted/sendMessage');
    expect(redacted).not.toContain('AAExampleToken');
  });

  it('does not leak a path key when prose punctuation follows the URL', () => {
    const key = 'AbCdEf0123456789xyzQQ';
    const redacted = redactMessage(`request to https://rpc.example.com/v2/${key}). failed`);
    expect(redacted).not.toContain(key);
    expect(redacted).toContain('/redacted');
  });

  it('removes a fragment in case a configured endpoint put a credential there', () => {
    expect(redactUrl('https://rpc.example.com/path#secret-token')).toBe(
      'https://rpc.example.com/path#redacted',
    );
  });

  it('removes basic auth credentials', () => {
    expect(redactUrl('https://user:pass@rpc.example.com/')).not.toContain('pass');
  });

  it('leaves an ordinary endpoint alone', () => {
    expect(redactUrl('https://gamma-api.polymarket.com/markets'))
      .toBe('https://gamma-api.polymarket.com/markets');
  });

  it('returns a non-URL untouched instead of throwing', () => {
    expect(redactUrl('connection reset')).toBe('connection reset');
  });
});

describe('redactMessage', () => {
  it('scrubs a URL embedded in an error string', () => {
    const msg = 'request to https://polygon.example.com/v2/KEY0123456789abcdefgh failed';
    expect(redactMessage(msg)).toBe('request to https://polygon.example.com/v2/redacted failed');
  });

  it('recognises an upper-case URL scheme too', () => {
    const msg = 'request to HTTPS://polygon.example.com/v2/KEY0123456789abcdefgh failed';
    expect(redactMessage(msg)).not.toContain('KEY0123456789abcdefgh');
  });

  it('also strips terminal control characters from remote error text', () => {
    expect(redactMessage('failed\u001b[2J\rforged')).toBe('failed[2J forged');
  });
});

describe('safeEndpoint', () => {
  it('accepts http and https', () => {
    expect(safeEndpoint('https://rpc.example.com').protocol).toBe('https:');
    expect(safeEndpoint('http://127.0.0.1:8545').protocol).toBe('http:');
  });

  it('refuses a scheme that would turn a config value into a file read', () => {
    expect(() => safeEndpoint('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => safeEndpoint('data:text/plain,x')).toThrow(/http or https/);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => safeEndpoint('rpc.example.com')).toThrow(/valid URL/);
  });
});
