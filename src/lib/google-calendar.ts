import { google } from 'googleapis';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { createHash } from 'crypto';
import { slugify, type Attendee, type CalendarEvent } from '@/types';

const TZ = 'America/Denver';
const SUBJECT_PREFIX_RE = /^(?:re:|fwd:)\s*/i;

type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

let cachedAuth: OAuth2 | null = null;
function getAuth(): OAuth2 {
  if (!cachedAuth) {
    cachedAuth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    cachedAuth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return cachedAuth;
}

export async function getTodaysEvents(date: Date): Promise<CalendarEvent[]> {
  const isoDay = formatInTimeZone(date, TZ, 'yyyy-MM-dd');
  const timeMin = fromZonedTime(`${isoDay}T00:00:00.000`, TZ).toISOString();
  const timeMax = fromZonedTime(`${isoDay}T23:59:59.999`, TZ).toISOString();

  const calendar = google.calendar({ version: 'v3', auth: getAuth() });
  const { data } = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (data.items ?? [])
    .filter((e) => e.status !== 'cancelled')
    .filter((e): e is typeof e & { id: string } => Boolean(e.id))
    // Skip all-day events: they have start.date but no start.dateTime. Parsing
    // "YYYY-MM-DDT00:00:00" as a naked Date is ambiguous (UTC vs local on Node),
    // and briefs for OOO/blocked-all-day events aren't useful anyway.
    .filter((e) => Boolean(e.start?.dateTime && e.end?.dateTime))
    .map((e) => {
      const attendees: Attendee[] = (e.attendees ?? [])
        .filter((a): a is typeof a & { email: string } => Boolean(a.email))
        .map((a) => ({
          email: a.email,
          name: a.displayName ?? undefined,
          organizer: a.organizer ?? undefined,
          responseStatus: a.responseStatus as Attendee['responseStatus'] | undefined,
        }));
      return {
        id: e.id,
        recurringEventId: e.recurringEventId ?? undefined,
        title: e.summary ?? '(no title)',
        description: e.description ?? undefined,
        startTime: e.start!.dateTime as string,
        endTime: e.end!.dateTime as string,
        attendees,
      };
    });
}

export function deriveSeriesId(event: CalendarEvent): string {
  if (event.recurringEventId) return event.recurringEventId;
  const normalized = event.title.toLowerCase().replace(SUBJECT_PREFIX_RE, '').trim();
  const slug = slugify(normalized);
  const emails = event.attendees
    .map((a) => a.email.toLowerCase())
    .sort()
    .join(',');
  const hash = createHash('sha1').update(emails).digest('hex');
  return `adhoc:${slug}:${hash}`;
}
