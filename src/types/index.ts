export type Attendee = {
  email: string;
  name?: string;
  organizer?: boolean;
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
};

export type CalendarEvent = {
  id: string;
  recurringEventId?: string;
  title: string;
  description?: string;
  startTime: string;  // ISO
  endTime: string;    // ISO
  attendees: Attendee[];
};

export type Meeting = {
  id: string;
  series_id: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  attendees: Attendee[];
  brief_generated_at?: string;
  notes_extracted_at?: string;
};

export type QrPayload = {
  meetingId: string;
  seriesId: string;
  date: string;      // YYYY-MM-DD
  version: number;   // start at 1; bump only if PDF format changes
};

const SLUG_MAX_LEN = 40;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN);
}

export function encodeFilename(date: string, title: string, meetingId: string): string {
  return `${date}__${slugify(title)}__${meetingId}.pdf`;
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})__([a-z0-9-]+)__(.+)\.pdf$/;

export function decodeFilename(filename: string):
  | { date: string; slug: string; meetingId: string }
  | null {
  const m = filename.match(FILENAME_RE);
  if (!m) return null;
  return { date: m[1], slug: m[2], meetingId: m[3] };
}
