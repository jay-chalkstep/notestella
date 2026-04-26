import { describe, it, expect } from 'vitest';
import { slugify, encodeFilename, decodeFilename } from '@/types';

describe('slugify', () => {
  it('lowercases and joins on hyphens', () => {
    expect(slugify('Quarterly Review')).toBe('quarterly-review');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(slugify('A & B  --  C!!!')).toBe('a-b-c');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('truncates to 40 chars', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long)).toHaveLength(40);
  });

  it('strips diacritics-adjacent characters via the alnum filter', () => {
    expect(slugify('café & crêpe')).toBe('caf-cr-pe');
  });
});

describe('encodeFilename / decodeFilename', () => {
  it('roundtrips a typical meeting brief filename', () => {
    const fn = encodeFilename('2026-04-26', 'Quarterly Review', 'evt_abc123');
    expect(fn).toBe('2026-04-26__quarterly-review__evt_abc123.pdf');
    const decoded = decodeFilename(fn);
    expect(decoded).toEqual({
      date: '2026-04-26',
      slug: 'quarterly-review',
      meetingId: 'evt_abc123',
    });
  });

  it('decodes meeting ids that contain underscores', () => {
    const decoded = decodeFilename('2026-04-26__sync__evt_abc_def_ghi.pdf');
    expect(decoded).toEqual({
      date: '2026-04-26',
      slug: 'sync',
      meetingId: 'evt_abc_def_ghi',
    });
  });

  it('returns null for reflection filenames (handled separately by evening-sync)', () => {
    expect(decodeFilename('reflection-daily-2026-04-26.pdf')).toBeNull();
    expect(decodeFilename('reflection-weekly-2026-04-20.pdf')).toBeNull();
  });

  it('returns null for malformed filenames', () => {
    expect(decodeFilename('whatever.pdf')).toBeNull();
    expect(decodeFilename('2026-04-26__quarterly-review.pdf')).toBeNull();
    expect(decodeFilename('2026-04-26__Caps-Not-Allowed__id.pdf')).toBeNull();
  });
});
