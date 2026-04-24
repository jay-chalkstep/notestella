import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getSupabase } from '@/lib/supabase';
import {
  generateWeeklyReflection,
  type WeeklyReflectionInput,
  type DailyReflectionMeeting,
  type DailyReflectionNote,
  type HubspotSnapshotDelta,
} from '@/lib/anthropic';
import type { Attendee } from '@/types';

const TZ = 'America/Denver';

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function bearerOk(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

// Monday 00:00 MT through Sunday 23:59 MT for the week ending on `ref` (which is
// the Sunday the cron fires on).
function weekBounds(ref: Date): {
  mondayIso: string;
  sundayIso: string;
  mondayDate: string;
  sundayDate: string;
  mondayStartUtc: Date;
  sundayEndUtc: Date;
} {
  const todayMt = formatInTimeZone(ref, TZ, 'yyyy-MM-dd');
  // Determine weekday in MT. Parse as noon MT to avoid edge dst issues.
  const noon = fromZonedTime(`${todayMt}T12:00:00`, TZ);
  const weekday = Number(formatInTimeZone(noon, TZ, 'i')); // 1 Mon .. 7 Sun
  const daysSinceMonday = weekday - 1;
  const daysUntilSunday = 7 - weekday;

  const mondayDate = formatInTimeZone(
    new Date(noon.getTime() - daysSinceMonday * 86_400_000),
    TZ,
    'yyyy-MM-dd'
  );
  const sundayDate = formatInTimeZone(
    new Date(noon.getTime() + daysUntilSunday * 86_400_000),
    TZ,
    'yyyy-MM-dd'
  );
  const mondayStartUtc = fromZonedTime(`${mondayDate}T00:00:00.000`, TZ);
  const sundayEndUtc = fromZonedTime(`${sundayDate}T23:59:59.999`, TZ);
  return {
    mondayIso: mondayStartUtc.toISOString(),
    sundayIso: sundayEndUtc.toISOString(),
    mondayDate,
    sundayDate,
    mondayStartUtc,
    sundayEndUtc,
  };
}

type MeetingRow = {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  attendees: Attendee[];
};

type NoteRow = {
  id: string;
  meeting_id: string;
  summary: string | null;
  decisions: unknown[];
  action_items: unknown[];
};

async function loadMeetings(startIso: string, endIso: string): Promise<MeetingRow[]> {
  const { data, error } = await getSupabase()
    .from('meetings')
    .select('id, title, start_time, end_time, attendees')
    .gte('start_time', startIso)
    .lte('start_time', endIso)
    .order('start_time', { ascending: true });
  if (error) throw new Error(`meetings: ${error.message}`);
  return (data ?? []) as MeetingRow[];
}

async function loadNotes(startDate: string, endDate: string): Promise<NoteRow[]> {
  const { data, error } = await getSupabase()
    .from('notes')
    .select('id, meeting_id, summary, decisions, action_items')
    .gte('note_date', startDate)
    .lte('note_date', endDate);
  if (error) throw new Error(`notes: ${error.message}`);
  return (data ?? []) as NoteRow[];
}

function toMeeting(m: MeetingRow): DailyReflectionMeeting {
  return {
    meeting_id: m.id,
    title: m.title,
    startTime: formatInTimeZone(new Date(m.start_time), TZ, 'HH:mm'),
    endTime: formatInTimeZone(new Date(m.end_time), TZ, 'HH:mm'),
    attendees: (m.attendees ?? []).map((a) => a.name ?? a.email),
  };
}

function toNote(n: NoteRow): DailyReflectionNote {
  return {
    note_id: n.id,
    meeting_id: n.meeting_id,
    summary: n.summary,
    decisions: n.decisions ?? [],
    action_items: n.action_items ?? [],
  };
}

async function loadHubspotDelta(): Promise<HubspotSnapshotDelta | null> {
  const { data, error } = await getSupabase()
    .from('hubspot_snapshots')
    .select('snapshot_date, pipeline_by_stage, rep_activity, top_open_deals')
    .order('snapshot_date', { ascending: false })
    .limit(2);
  if (error) {
    console.error('[weekly-reflection] hubspot snapshots load failed', error.message);
    return null;
  }
  const rows = (data ?? []) as Array<{
    snapshot_date: string;
    pipeline_by_stage: unknown;
    rep_activity: unknown;
    top_open_deals: unknown;
  }>;
  if (rows.length === 0) return null;
  return {
    current: rows[0],
    previous: rows[1] ?? null,
  };
}

export async function POST(req: Request): Promise<Response> {
  if (!bearerOk(req)) return unauthorized();

  const now = new Date();
  const { mondayDate, sundayDate, mondayStartUtc, sundayEndUtc } = weekBounds(now);
  const priorMondayStart = new Date(mondayStartUtc.getTime() - 7 * 86_400_000);
  const priorSundayEnd = new Date(sundayEndUtc.getTime() - 7 * 86_400_000);
  const priorMondayDate = formatInTimeZone(priorMondayStart, TZ, 'yyyy-MM-dd');
  const priorSundayDate = formatInTimeZone(priorSundayEnd, TZ, 'yyyy-MM-dd');

  const [meetingRows, noteRows, priorMeetingRows, priorNoteRows, hubspot] = await Promise.all([
    loadMeetings(mondayStartUtc.toISOString(), sundayEndUtc.toISOString()),
    loadNotes(mondayDate, sundayDate),
    loadMeetings(priorMondayStart.toISOString(), priorSundayEnd.toISOString()),
    loadNotes(priorMondayDate, priorSundayDate),
    loadHubspotDelta(),
  ]);

  const input: WeeklyReflectionInput = {
    period_start: mondayDate,
    period_end: sundayDate,
    meetings: meetingRows.map(toMeeting),
    notes: noteRows.map(toNote),
    prior_week_meetings: priorMeetingRows.map(toMeeting),
    prior_week_notes: priorNoteRows.map(toNote),
    hubspot,
  };

  if (input.meetings.length === 0 && input.notes.length === 0) {
    return Response.json({ skipped: true, reason: 'no_activity' }, { status: 200 });
  }

  const reflection = await generateWeeklyReflection(input);
  // pdf_filename is the intended delivery filename; no PDF is rendered or stored
  // here. morning-brief re-renders from content jsonb at email time — content
  // is the source of truth, the PDF is disposable.
  const pdfFilename = `reflection-weekly-${mondayDate}.pdf`;

  const { data: inserted, error: insertErr } = await getSupabase()
    .from('reflections')
    .upsert(
      {
        type: 'weekly',
        period_start: mondayDate,
        period_end: sundayDate,
        content: reflection,
        pdf_filename: pdfFilename,
        source_notes: input.notes.map((n) => n.note_id),
        source_meetings: input.meetings.map((m) => m.meeting_id),
      },
      { onConflict: 'type,period_start' }
    )
    .select('id')
    .single();
  if (insertErr) {
    return Response.json({ error: `reflections upsert: ${insertErr.message}` }, { status: 500 });
  }

  return Response.json(
    {
      reflection_id: (inserted as { id: string }).id,
      period_start: mondayDate,
      period_end: sundayDate,
      meeting_count: input.meetings.length,
      note_count: input.notes.length,
    },
    { status: 200 }
  );
}
