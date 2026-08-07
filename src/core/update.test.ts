import { describe, expect, it } from 'vitest';
import { isNewer, updateNotice } from './update.js';

describe('isNewer', () => {
  it('compares each position numerically, not as text', () => {
    // The whole point. String comparison puts 0.10.0 below 0.9.0 and would
    // tell someone they are up to date when they are nine releases behind.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('is false for the same version', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
  });

  it('tolerates a v prefix and missing positions', () => {
    expect(isNewer('v1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('2', '1.9.9')).toBe(true);
  });

  it('treats a release as newer than its own prerelease', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('does not offer a downgrade', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });
});

describe('updateNotice', () => {
  it('says nothing when there is nothing to say', () => {
    expect(updateNotice({ current: '1.0.0', latest: '1.0.0', behind: false })).toBeUndefined();
    expect(updateNotice({ current: '1.0.0', behind: false, reason: 'offline' })).toBeUndefined();
  });

  it('names both versions and the command, and does not run it', () => {
    const notice = updateNotice({ current: '0.1.0', latest: '0.2.0', behind: true })!;
    expect(notice).toContain('0.1.0');
    expect(notice).toContain('0.2.0');
    expect(notice).toContain('npm i -g recuse');
  });
});
