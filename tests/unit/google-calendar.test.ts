import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deriveSeriesId } from '@/lib/google-calendar';
import type { CalendarEvent } from '@/types';

const baseEvent = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'evt-1',
  title: 'Quarterly review with ACME',
  startTime: '2026-04-26T15:00:00Z',
  endTime: '2026-04-26T16:00:00Z',
  attendees: [],
  ...over,
});

describe('deriveSeriesId', () => {
  const originalEnv = process.env.MY_EMAIL;

  beforeEach(() => {
    process.env.MY_EMAIL = 'jay@cdco.io';
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MY_EMAIL;
    else process.env.MY_EMAIL = originalEnv;
  });

  it('uses the Google recurringEventId as-is when present', () => {
    const e = baseEvent({ recurringEventId: 'rec_abc123' });
    expect(deriveSeriesId(e)).toBe('rec_abc123');
  });

  it('produces the same id when an attendee is added within the same domain', () => {
    const a = baseEvent({
      attendees: [
        { email: 'alice@acme.com' },
        { email: 'jay@cdco.io' },
      ],
    });
    const b = baseEvent({
      attendees: [
        { email: 'alice@acme.com' },
        { email: 'bob@acme.com' },
        { email: 'jay@cdco.io' },
      ],
    });
    expect(deriveSeriesId(a)).toBe(deriveSeriesId(b));
  });

  it('produces a different id when the external domain changes', () => {
    const a = baseEvent({
      attendees: [{ email: 'alice@acme.com' }, { email: 'jay@cdco.io' }],
    });
    const b = baseEvent({
      attendees: [{ email: 'alice@globex.com' }, { email: 'jay@cdco.io' }],
    });
    expect(deriveSeriesId(a)).not.toBe(deriveSeriesId(b));
  });

  it('strips re:/fwd: prefixes from the title slug', () => {
    const a = baseEvent({ title: 'Quarterly review with ACME' });
    const b = baseEvent({ title: 'Re: Quarterly review with ACME' });
    const c = baseEvent({ title: 'FWD: Quarterly review with ACME' });
    const id = deriveSeriesId(a);
    expect(deriveSeriesId(b)).toBe(id);
    expect(deriveSeriesId(c)).toBe(id);
  });

  it('groups all internal-only meetings with the same title under one series', () => {
    const monday = baseEvent({
      title: 'Eng standup',
      attendees: [{ email: 'jay@cdco.io' }, { email: 'alex@cdco.io' }],
    });
    const tuesday = baseEvent({
      title: 'Eng standup',
      attendees: [{ email: 'jay@cdco.io' }, { email: 'alex@cdco.io' }, { email: 'sam@cdco.io' }],
    });
    expect(deriveSeriesId(monday)).toBe(deriveSeriesId(tuesday));
  });

  it('treats counterparty meetings with multiple external orgs as one series', () => {
    // Joint pitch with both ACME and Globex — the external-domain set is the
    // identity, so adding/removing one rep on either side keeps the series.
    const a = baseEvent({
      attendees: [
        { email: 'alice@acme.com' },
        { email: 'glen@globex.com' },
        { email: 'jay@cdco.io' },
      ],
    });
    const b = baseEvent({
      attendees: [
        { email: 'alice@acme.com' },
        { email: 'glen@globex.com' },
        { email: 'gary@globex.com' },
        { email: 'jay@cdco.io' },
      ],
    });
    expect(deriveSeriesId(a)).toBe(deriveSeriesId(b));
  });
});
