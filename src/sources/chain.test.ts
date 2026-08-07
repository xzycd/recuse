/**
 * The chain layer is not wired into an assessment, and these tests exist to
 * make sure nothing quietly starts claiming that it is.
 *
 * The bug being pinned: the evidence tier used to be assembled from
 * `Boolean(process.env.RECUSE_RPC_URL)`, so exporting the variable upgraded
 * every reading to `positions+chain` without a single oracle request being
 * made. A file: URL did it too, because the scheme check lived in a constructor
 * nothing called. Both of those are one refactor away from returning.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chainNote, chainStatus } from './chain.js';

const KEY = 'RECUSE_RPC_URL';

afterEach(() => {
  delete process.env[KEY];
});

describe('chainStatus', () => {
  it('reads nothing, whatever the environment says', () => {
    expect(chainStatus().reads).toBe(false);

    process.env[KEY] = 'https://polygon.example.com/v2/key';
    expect(chainStatus().reads).toBe(false);
  });

  it('separates configured from usable', () => {
    expect(chainStatus().configured).toBe(false);

    process.env[KEY] = 'https://polygon.example.com/v2/key';
    const set = chainStatus();
    expect(set.configured).toBe(true);
    expect(set.rejected).toBeUndefined();
  });

  it('runs the scheme check that used to sit in an unreachable constructor', () => {
    process.env[KEY] = 'file:///etc/passwd';
    const status = chainStatus();
    expect(status.configured).toBe(true);
    expect(status.rejected).toMatch(/http/);
  });

  it('rejects a value that is not a URL at all', () => {
    process.env[KEY] = 'not-a-url';
    expect(chainStatus().rejected).toMatch(/valid URL/);
  });
});

describe('chainNote', () => {
  it('says the oracle is unread when nothing is configured', () => {
    expect(chainNote()).toMatch(/unread/);
  });

  it('tells a user who set the variable that it bought them nothing', () => {
    process.env[KEY] = 'https://polygon.example.com/v2/key';
    const note = chainNote();
    expect(note).toMatch(/set but unused/);
    expect(note).toMatch(/unread/);
  });

  it('names a rejected endpoint rather than ignoring it silently', () => {
    process.env[KEY] = 'file:///etc/passwd';
    expect(chainNote()).toMatch(/ignored/);
  });

  it('never leaks the endpoint, which usually carries an API key', () => {
    process.env[KEY] = 'https://polygon.example.com/v2/secret-key-material';
    expect(chainNote()).not.toMatch(/secret-key-material/);
  });
});
