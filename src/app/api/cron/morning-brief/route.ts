import { formatInTimeZone } from 'date-fns-tz';
import { getSupabase } from '@/lib/supabase';
import { getTodaysEvents, deriveSeriesId } from '@/lib/google-calendar';
import {
  generateMeetingBrief,
  generateDailyOverview,
  type PriorMeeting,
} from '@/lib/anthropic';
import { renderMeetingBriefPdf } from '@/pdf/meeting-brief';
import { renderDailyOverviewPdf } from '@/pdf/daily-overview';
import { sendPdfsToRemarkable } from '@/lib/resend';
import { encodeFilename, type CalendarEvent } from '@/types';

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

async function loadPriors(seriesId: string, beforeIso: string): Promise<PriorMeeting[]> {
  const { data, error } = await getSupabase()
    .from('meetings')
    .select('start_time, title')
    .eq('series_id', seriesId)
    .lt('start_time', beforeIso)
    .order('start_time', { ascending: false })
    .limit(5);
  if (error) throw new Error(`priors query: ${error.message}`);
  return (data ?? []).map((row) => ({
    date: formatInTimeZone(new Date(row.start_time as string), TZ, 'yyyy-MM-dd'),
    title: row.title as string,
    summary: 'briefed only',
    decisions: [],
    action_items: [],
  }));
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
      const brief = await generateMeetingBrief({
        title: event.title,
        date: today,
        startTime: fmtTime(event.startTime),
        endTime: fmtTime(event.endTime),
        attendees: event.attendees,
        description: event.description,
        priors,
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
      delivered,
      per_meeting: perMeeting,
    },
    { status }
  );
}
