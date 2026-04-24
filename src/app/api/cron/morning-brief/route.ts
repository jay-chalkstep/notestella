import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getSupabase } from '@/lib/supabase';
import { getTodaysEvents, deriveSeriesId } from '@/lib/google-calendar';
import {
  generateMeetingBrief,
  generateDailyOverview,
  type PriorMeeting,
  type BriefCrmData,
} from '@/lib/anthropic';
import { renderMeetingBriefPdf } from '@/pdf/meeting-brief';
import { renderDailyOverviewPdf } from '@/pdf/daily-overview';
import { renderDailyReflectionPdf } from '@/pdf/daily-reflection';
import { renderWeeklyReflectionPdf } from '@/pdf/weekly-reflection';
import type {
  DailyReflectionOutput,
  WeeklyReflectionOutput,
} from '@/lib/anthropic';
import { sendPdfsToRemarkable } from '@/lib/resend';
import { selectLens } from '@/lib/lens';
import {
  getCustomerLensData,
  getSellerLensData,
  getExecutiveLensData,
} from '@/lib/hubspot';
import { encodeFilename, type Attendee, type CalendarEvent } from '@/types';

const TZ = 'America/Denver';

type MeetingRow = {
  id: string;
  series_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  attendees: CalendarEvent['attendees'];
};

type PerMeetingResult = {
  meeting_id: string;
  title: string;
  status: 'briefed' | 'skipped_no_attendees' | 'error';
  error?: string;
};

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function bearerOk(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

function fmtTime(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, 'HH:mm');
}

async function fetchCrmData(
  attendees: Attendee[],
  myEmail: string,
  cache: Map<string, BriefCrmData>
): Promise<BriefCrmData> {
  const selection = await selectLens(attendees, myEmail);

  if (selection.lens === 'none') return null;

  switch (selection.lens) {
    case 'customer': {
      const externalEmails = attendees
        .map((a) => a.email)
        .filter((e) => e.toLowerCase() !== myEmail.toLowerCase());
      const key = `customer:${externalEmails.sort().join(',')}`;
      if (cache.has(key)) return cache.get(key)!;
      const data = await getCustomerLensData(externalEmails);
      cache.set(key, data);
      return data;
    }
    case 'seller': {
      if (!selection.focusPersonOwnerId) return null;
      const key = `seller:${selection.focusPersonOwnerId}`;
      if (cache.has(key)) return cache.get(key)!;
      const data = await getSellerLensData(selection.focusPersonOwnerId);
      cache.set(key, data);
      return data;
    }
    case 'sales_leader': {
      const key = 'exec';
      if (cache.has(key)) return cache.get(key)!;
      const data = await getExecutiveLensData();
      cache.set(key, data);
      return data;
    }
  }
}

async function loadPriors(seriesId: string, beforeIso: string): Promise<PriorMeeting[]> {
  const { data: meetingRows, error } = await getSupabase()
    .from('meetings')
    .select('id, start_time, title')
    .eq('series_id', seriesId)
    .lt('start_time', beforeIso)
    .order('start_time', { ascending: false })
    .limit(5);
  if (error) throw new Error(`priors query: ${error.message}`);
  const meetings = (meetingRows ?? []) as Array<{ id: string; start_time: string; title: string }>;
  if (meetings.length === 0) return [];

  const ids = meetings.map((m) => m.id);
  const { data: noteRows, error: notesErr } = await getSupabase()
    .from('notes')
    .select('meeting_id, summary, decisions, action_items')
    .in('meeting_id', ids);
  if (notesErr) throw new Error(`prior notes query: ${notesErr.message}`);

  const notesByMeeting = new Map<
    string,
    { summaries: string[]; decisions: unknown[]; action_items: unknown[] }
  >();
  for (const n of (noteRows ?? []) as Array<{
    meeting_id: string;
    summary: string | null;
    decisions: unknown[];
    action_items: unknown[];
  }>) {
    const agg = notesByMeeting.get(n.meeting_id) ?? {
      summaries: [],
      decisions: [],
      action_items: [],
    };
    if (n.summary) agg.summaries.push(n.summary);
    agg.decisions.push(...(n.decisions ?? []));
    agg.action_items.push(...(n.action_items ?? []));
    notesByMeeting.set(n.meeting_id, agg);
  }

  return meetings.map((m) => {
    const notes = notesByMeeting.get(m.id);
    return {
      date: formatInTimeZone(new Date(m.start_time), TZ, 'yyyy-MM-dd'),
      title: m.title,
      summary: notes && notes.summaries.length > 0 ? notes.summaries.join(' ') : 'briefed only',
      decisions: notes?.decisions ?? [],
      action_items: notes?.action_items ?? [],
    };
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!bearerOk(req)) return unauthorized();

  const now = new Date();
  const today = formatInTimeZone(now, TZ, 'yyyy-MM-dd');
  const formattedDate = formatInTimeZone(now, TZ, 'EEEE, MMM d');

  const events = await getTodaysEvents(now);

  const rows: MeetingRow[] = events.map((e) => ({
    id: e.id,
    series_id: deriveSeriesId(e),
    title: e.title,
    description: e.description ?? null,
    start_time: e.startTime,
    end_time: e.endTime,
    attendees: e.attendees,
  }));

  if (rows.length > 0) {
    const { error: upsertErr } = await getSupabase()
      .from('meetings')
      .upsert(rows, { onConflict: 'id' });
    if (upsertErr) {
      return Response.json(
        { error: `meetings upsert: ${upsertErr.message}` },
        { status: 500 }
      );
    }
  }

  const attachments: { filename: string; buffer: Buffer }[] = [];
  const perMeeting: PerMeetingResult[] = [];
  const briefedIds: string[] = [];
  const myEmail = process.env.MY_EMAIL;
  const crmCache = new Map<string, BriefCrmData>();

  for (const event of events) {
    if (event.attendees.length === 0) {
      perMeeting.push({
        meeting_id: event.id,
        title: event.title,
        status: 'skipped_no_attendees',
      });
      continue;
    }
    try {
      const seriesId = deriveSeriesId(event);
      const priors = await loadPriors(seriesId, now.toISOString());
      let crmData: BriefCrmData = null;
      if (myEmail) {
        try {
          crmData = await fetchCrmData(event.attendees, myEmail, crmCache);
        } catch (err) {
          console.error('[morning-brief] CRM fetch failed; continuing without', {
            meeting_id: event.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const brief = await generateMeetingBrief({
        title: event.title,
        date: today,
        startTime: fmtTime(event.startTime),
        endTime: fmtTime(event.endTime),
        attendees: event.attendees,
        description: event.description,
        priors,
        crmData,
      });
      const filename = encodeFilename(today, event.title, event.id);
      const buffer = await renderMeetingBriefPdf({
        meeting: {
          id: event.id,
          seriesId,
          title: event.title,
          date: today,
          startTime: fmtTime(event.startTime),
          endTime: fmtTime(event.endTime),
          attendees: event.attendees,
        },
        brief,
        filename,
      });
      attachments.push({ filename, buffer });
      briefedIds.push(event.id);

      const { error: insertErr } = await getSupabase().from('briefs').insert({
        meeting_id: event.id,
        brief_date: today,
        brief_type: 'meeting',
        pdf_filename: filename,
      });
      if (insertErr) throw new Error(`briefs insert: ${insertErr.message}`);

      perMeeting.push({
        meeting_id: event.id,
        title: event.title,
        status: 'briefed',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[morning-brief] per-meeting failure', {
        meeting_id: event.id,
        title: event.title,
        error: msg,
      });
      perMeeting.push({
        meeting_id: event.id,
        title: event.title,
        status: 'error',
        error: msg,
      });
    }
  }

  // Daily overview — best-effort; don't fail the whole run if it errors
  let overviewAttached = false;
  try {
    const overview = await generateDailyOverview({
      date: today,
      meetings: events.map((e) => ({
        title: e.title,
        startTime: fmtTime(e.startTime),
        endTime: fmtTime(e.endTime),
        attendeeCount: e.attendees.length,
      })),
    });
    const overviewBuffer = await renderDailyOverviewPdf({
      date: today,
      formattedDate,
      meetings: events.map((e) => ({
        title: e.title,
        startTime: fmtTime(e.startTime),
        endTime: fmtTime(e.endTime),
        attendeeCount: e.attendees.length,
      })),
      overview,
    });
    const overviewFilename = `${today}__daily-overview__daily.pdf`;
    attachments.push({ filename: overviewFilename, buffer: overviewBuffer });
    overviewAttached = true;

    const { error: insertErr } = await getSupabase().from('briefs').insert({
      meeting_id: null,
      brief_date: today,
      brief_type: 'daily_overview',
      pdf_filename: overviewFilename,
    });
    if (insertErr) {
      console.error('[morning-brief] daily overview briefs insert failed', insertErr.message);
    }
  } catch (err) {
    console.error(
      '[morning-brief] daily overview failure',
      err instanceof Error ? err.message : String(err)
    );
  }

  // §5.8 Attach the most recent undelivered reflection.
  let reflectionAttachedId: string | null = null;
  try {
    const { data: refRow, error: refErr } = await getSupabase()
      .from('reflections')
      .select('id, type, period_start, period_end, content, pdf_filename')
      .is('delivered_at', null)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (refErr) {
      console.error('[morning-brief] reflections lookup failed', refErr.message);
    } else if (refRow) {
      const row = refRow as {
        id: string;
        type: 'daily' | 'weekly';
        period_start: string;
        period_end: string;
        content: unknown;
        pdf_filename: string | null;
      };
      if (row.type === 'daily') {
        const buf = await renderDailyReflectionPdf({
          date: row.period_start,
          formattedDate: formatInTimeZone(
            fromZonedTime(`${row.period_start}T12:00:00`, TZ),
            TZ,
            'EEEE, MMM d'
          ),
          reflection: row.content as DailyReflectionOutput,
        });
        attachments.push({
          filename: row.pdf_filename ?? `reflection-daily-${row.period_start}.pdf`,
          buffer: buf,
        });
        reflectionAttachedId = row.id;
      } else if (row.type === 'weekly') {
        const buf = await renderWeeklyReflectionPdf({
          period_start: row.period_start,
          period_end: row.period_end,
          formattedRange: `${formatInTimeZone(fromZonedTime(`${row.period_start}T12:00:00`, TZ), TZ, 'MMM d')} – ${formatInTimeZone(fromZonedTime(`${row.period_end}T12:00:00`, TZ), TZ, 'MMM d')}`,
          reflection: row.content as WeeklyReflectionOutput,
        });
        attachments.push({
          filename: row.pdf_filename ?? `reflection-weekly-${row.period_start}.pdf`,
          buffer: buf,
        });
        reflectionAttachedId = row.id;
      }
    }
  } catch (err) {
    console.error(
      '[morning-brief] reflection attach failed',
      err instanceof Error ? err.message : String(err)
    );
  }

  let delivered = false;
  if (attachments.length > 0) {
    try {
      await sendPdfsToRemarkable(attachments, `Notestella — ${formattedDate}`);
      delivered = true;

      if (briefedIds.length > 0) {
        const nowIso = new Date().toISOString();
        const { error: updErr } = await getSupabase()
          .from('meetings')
          .update({ brief_generated_at: nowIso })
          .in('id', briefedIds);
        if (updErr) {
          console.error('[morning-brief] brief_generated_at update failed', updErr.message);
        }

        await getSupabase()
          .from('briefs')
          .update({ delivered_to_remarkable: true, delivered_at: nowIso })
          .eq('brief_date', today);
      }

      if (reflectionAttachedId) {
        const nowIso = new Date().toISOString();
        const { error: rUpdErr } = await getSupabase()
          .from('reflections')
          .update({ delivered_at: nowIso })
          .eq('id', reflectionAttachedId);
        if (rUpdErr) {
          console.error('[morning-brief] reflection delivered_at update failed', rUpdErr.message);
        }
      }
    } catch (err) {
      console.error(
        '[morning-brief] email send failed',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const anyError = perMeeting.some((m) => m.status === 'error') || !delivered;
  const status = anyError && events.length > 0 ? 207 : 200;

  return Response.json(
    {
      event_count: events.length,
      brief_count: briefedIds.length,
      overview_attached: overviewAttached,
      reflection_attached: reflectionAttachedId,
      delivered,
      per_meeting: perMeeting,
    },
    { status }
  );
}
