import { getSupabase } from '@/lib/supabase';
import { extractNotesFromImage } from '@/lib/anthropic';
import { embed } from '@/lib/voyage';
import { decodeFilename } from '@/types';

type Payload = {
  filename: string;
  page_number: number;
  image_base64: string;
};

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

  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body.filename || !body.image_base64 || typeof body.page_number !== 'number') {
    return Response.json({ error: 'missing fields' }, { status: 400 });
  }

  const parsed = decodeFilename(body.filename);
  if (!parsed) {
    return Response.json({ error: `malformed filename: ${body.filename}` }, { status: 400 });
  }
  const { date, meetingId } = parsed;

  const { data: meeting, error: meetingErr } = await getSupabase()
    .from('meetings')
    .select('id, series_id, title')
    .eq('id', meetingId)
    .maybeSingle();
  if (meetingErr) {
    return Response.json({ error: `meeting lookup: ${meetingErr.message}` }, { status: 500 });
  }
  if (!meeting) {
    return Response.json({ error: `meeting not found: ${meetingId}` }, { status: 404 });
  }

  const extraction = await extractNotesFromImage(body.image_base64, {
    title: meeting.title as string,
    date,
  });

  if ('skipped' in extraction && extraction.skipped === true) {
    return Response.json({ skipped: true, reason: 'no_handwriting' }, { status: 200 });
  }

  const content = extraction as Exclude<typeof extraction, { skipped: true }>;
  const embedding = await embed(`${content.summary}\n\n${content.raw_text}`);

  const { data: inserted, error: insertErr } = await getSupabase()
    .from('notes')
    .insert({
      meeting_id: meeting.id,
      series_id: meeting.series_id,
      page_number: body.page_number,
      raw_text: content.raw_text,
      summary: content.summary,
      decisions: content.decisions,
      action_items: content.action_items,
      embedding,
      note_date: date,
    })
    .select('id')
    .single();
  if (insertErr) {
    return Response.json({ error: `notes insert: ${insertErr.message}` }, { status: 500 });
  }

  const { error: updErr } = await getSupabase()
    .from('meetings')
    .update({ notes_extracted_at: new Date().toISOString() })
    .eq('id', meeting.id);
  if (updErr) {
    console.error('[evening-sync] notes_extracted_at update failed', updErr.message);
  }

  return Response.json(
    { skipped: false, note_id: (inserted as { id: string }).id },
    { status: 200 }
  );
}
