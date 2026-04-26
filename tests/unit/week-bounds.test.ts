import { describe, it, expect } from 'vitest';
import { weekBounds } from '@/app/api/cron/weekly-reflection/route';

describe('weekBounds', () => {
  it('returns Mon-Sun in MT for a Sunday reference date in the middle of the week', () => {
    // Sunday April 26, 2026 in MT (DST is in effect; MT = UTC-6).
    // Use noon UTC to avoid date boundary edge cases.
    const sunday = new Date('2026-04-26T18:00:00Z');
    const w = weekBounds(sunday);
    expect(w.mondayDate).toBe('2026-04-20');
    expect(w.sundayDate).toBe('2026-04-26');
  });

  it('returns the same week regardless of which day-of-week the ref is', () => {
    // Wednesday April 22, 2026 should still produce the Mon Apr 20 → Sun Apr 26 week.
    const wednesday = new Date('2026-04-22T18:00:00Z');
    const w = weekBounds(wednesday);
    expect(w.mondayDate).toBe('2026-04-20');
    expect(w.sundayDate).toBe('2026-04-26');
  });

  it('handles a Monday reference date by returning that Monday', () => {
    const monday = new Date('2026-04-20T18:00:00Z');
    const w = weekBounds(monday);
    expect(w.mondayDate).toBe('2026-04-20');
    expect(w.sundayDate).toBe('2026-04-26');
  });

  it('produces ISO strings ordered Mon < Sun', () => {
    const ref = new Date('2026-04-22T18:00:00Z');
    const w = weekBounds(ref);
    expect(new Date(w.mondayIso).getTime()).toBeLessThan(new Date(w.sundayIso).getTime());
  });
});
