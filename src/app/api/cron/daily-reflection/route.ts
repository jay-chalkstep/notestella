import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { getSupabase } from '@/lib/supabase';
import {
  generateDailyReflection,
  type DailyReflectionInput,
  type DailyReflectionMeeting,
  type DailyReflectionNote,
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

export async function POST(req: Request): Promise<Response> {
  if (!bearerOk(req)) return unauthorized();

  const now = new Date();
  const today = formatInTimeZone(now, TZ, 'yyyy-MM-dd');

  const dayStart = fromZonedTime(`${today}T00:00:00.000`, TZ);
  const dayEnd = fromZonedTime(`${today}T23:59:59.999`, TZ);

  const { data: meetingRows, error: mErr } = await getSupabase()
    .from('meetings')
    .select('id, title, start_time, end_time, attendees')
    .gte('start_time', dayStart.toISOString())
    .lte('start_time', dayEnd.toISOString())
    .order('start_time', { ascending: true });
  if (mErr) return Response.json({ error: `meetings: ${mErr.message}` }, { status: 500 });

  const { data: noteRows, error: nErr } = await getSupabase()
    .from('notes')
    .select('id, meeting_id, summary, decisions, action_items')
    .eq('note_date', today);
  if (nErr) return Response.json({ error: `notes: ${nErr.message}` }, { status: 500 });

  const meetings: DailyReflectionMeeting[] = (meetingRows ?? []).map((m) => {
    const row = m as {
      id: string;
      title: string;
      start_time: string;
      end_time: string;
      attendees: Attendee[];
    };
    return {
      meeting_id: row.id,
      title: row.title,
      startTime: formatInTimeZone(new Date(row.start_time), TZ, 'HH:mm'),
      endTime: formatInTimeZone(new Date(row.end_time), TZ, 'HH:mm'),
      attendees: (row.attendees ?? []).map((a) => a.name ?? a.email),
    };
  });

  const notes: DailyReflectionNote[] = (noteRows ?? []).map((n) => {
    const row = n as {
      id: string;
      meeting_id: string;
      summary: string | null;
      decisions: unknown[];
      action_items: unknown[];
    };
    return {
      note_id: row.id,
      meeting_id: row.meeting_id,
      summary: row.summary,
      decisions: row.decisions ?? [],
      action_items: row.action_items ?? [],
    };
  });

  if (meetings.length === 0 && notes.length === 0) {
    console.log('[daily-reflection] no activity today, skipping');
    return Response.json({ skipped: true, reason: 'no_activity' }, { status: 200 });
  }

  const input: DailyReflectionInput = { date: today, meetings, notes };
  const reflection = await generateDailyReflection(input);

  // pdf_filename is the intended delivery filename; no PDF is rendered or stored
  // here. morning-brief re-renders from content jsonb at email time — content
  // is the source of truth, the PDF is disposable.
  const pdfFilename = `reflection-daily-${today}.pdf`;

  const { data: inserted, error: insertErr } = await getSupabase()
    .from('reflections')
    .upsert(
      {
        type: 'daily',
        period_start: today,
        period_end: today,
        content: reflection,
        pdf_filename: pdfFilename,
        source_notes: notes.map((n) => n.note_id),
        source_meetings: meetings.map((m) => m.meeting_id),
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
      note_count: notes.length,
      meeting_count: meetings.length,
    },
    { status: 200 }
  );
}
