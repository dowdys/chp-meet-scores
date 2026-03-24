import { describe, it, expect, vi } from 'vitest';

// Mock Electron and transitive deps before importing the module under test
vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    getPath: (name: string) => `/mock/${name}`,
    isPackaged: false,
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
  },
  shell: { openPath: vi.fn() },
}));
vi.mock('electron-store', () => ({
  default: class MockStore {
    private data: Record<string, unknown> = {};
    get(key: string) { return this.data[key]; }
    set(key: string, val: unknown) { this.data[key] = val; }
  },
}));

import { decodeHtml, cleanName } from '../tools/extraction-tools';

describe('decodeHtml', () => {
  it('returns empty string for empty/falsy input', () => {
    expect(decodeHtml('')).toBe('');
    expect(decodeHtml(undefined as unknown as string)).toBe('');
  });

  it('decodes numeric HTML entities', () => {
    expect(decodeHtml('&#39;')).toBe("'");
    expect(decodeHtml('Smith&#39;s Gym')).toBe("Smith's Gym");
    expect(decodeHtml('&#38;')).toBe('&');
  });

  it('decodes named HTML entities', () => {
    expect(decodeHtml('&amp;')).toBe('&');
    expect(decodeHtml('&lt;')).toBe('<');
    expect(decodeHtml('&gt;')).toBe('>');
    expect(decodeHtml('&quot;')).toBe('"');
    expect(decodeHtml('&apos;')).toBe("'");
    expect(decodeHtml('&#39;')).toBe("'");
  });

  it('decodes multiple entities in one string', () => {
    expect(decodeHtml('A &amp; B &lt;C&gt;')).toBe('A & B <C>');
  });

  it('leaves plain text unchanged', () => {
    expect(decodeHtml('Jane Smith')).toBe('Jane Smith');
    expect(decodeHtml('Gold Medal Gymnastics')).toBe('Gold Medal Gymnastics');
  });
});

describe('cleanName', () => {
  it('returns clean name when no annotations', () => {
    expect(cleanName('Jane Smith')).toBe('Jane Smith');
    expect(cleanName('Mary O\'Brien')).toBe("Mary O'Brien");
  });

  it('strips single event annotations', () => {
    expect(cleanName('Jane Smith VT')).toBe('Jane Smith');
    expect(cleanName('Jane Smith UB')).toBe('Jane Smith');
    expect(cleanName('Jane Smith BB')).toBe('Jane Smith');
    expect(cleanName('Jane Smith FX')).toBe('Jane Smith');
  });

  it('strips multiple comma-separated event annotations', () => {
    expect(cleanName('Jane Smith VT,BB,FX')).toBe('Jane Smith');
    expect(cleanName('Jane Smith VT, UB, BB, FX')).toBe('Jane Smith');
  });

  it('strips IES prefix annotations', () => {
    expect(cleanName('Jane Smith IES VT,BB')).toBe('Jane Smith');
  });

  it('handles HTML entities in names', () => {
    expect(cleanName('O&#39;Brien')).toBe("O'Brien");
    expect(cleanName('Smith &amp; Jones VT')).toBe('Smith & Jones');
  });

  it('preserves names that happen to contain event-like substrings mid-name', () => {
    // "BB" at end gets stripped, but "VT" mid-name shouldn't be affected
    // This tests the regex anchoring at end-of-string
    expect(cleanName('Victoria Smith')).toBe('Victoria Smith');
  });

  it('trims whitespace', () => {
    expect(cleanName('  Jane Smith  ')).toBe('Jane Smith');
    expect(cleanName('Jane Smith  VT ')).toBe('Jane Smith');
  });
});
