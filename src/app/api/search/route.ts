import { getSupabase } from '@/lib/supabase';
import { embed } from '@/lib/voyage';
import { generateSearchAnswer, type SearchCandidate } from '@/lib/anthropic';

type SearchBody = { query: string };

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function readSecretOk(req: Request): boolean {
  const secret = process.env.NOTESTELLA_READ_SECRET;
  // Fail closed: if the env var isn't set, the route refuses all traffic.
  // Set NOTESTELLA_READ_SECRET in Vercel before deploying the homepage publicly.
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

type MatchRow = {
  id: string;
  meeting_id: string;
  series_id: string;
  raw_text: string;
  summary: string | null;
  note_date: string;
  similarity: number;
};

export async function POST(req: Request): Promise<Response> {
  if (!readSecretOk(req)) return unauthorized();

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const query = body.query?.trim();
  if (!query) {
    return Response.json({ error: 'query is required' }, { status: 400 });
  }

  const queryEmbedding = await embed(query);

  const { data: matches, error: rpcErr } = await getSupabase().rpc('match_notes', {
    query_embedding: queryEmbedding,
    match_threshold: 0.7,
    match_count: 12,
  });
  if (rpcErr) {
    return Response.json({ error: `match_notes: ${rpcErr.message}` }, { status: 500 });
  }

  const rows = (matches ?? []) as MatchRow[];
  if (rows.length === 0) {
    return Response.json(
      {
        answer: "I don't have any notes that support an answer to that question.",
        citations: [],
      },
      { status: 200 }
    );
  }

  const candidates: SearchCandidate[] = rows.map((r, i) => ({
    ref: `n${i + 1}`,
    note_id: r.id,
    meeting_id: r.meeting_id,
    date: r.note_date,
    summary: r.summary,
    raw_text: r.raw_text,
  }));

  const synth = await generateSearchAnswer(query, candidates);

  const citations = synth.cited_ids
    .map((ref) => candidates.find((c) => c.ref === ref))
    .filter((c): c is SearchCandidate => Boolean(c))
    .map((c) => ({
      ref: c.ref,
      note_id: c.note_id,
      meeting_id: c.meeting_id,
      date: c.date,
      snippet: c.summary ?? c.raw_text.slice(0, 200),
    }));

  return Response.json(
    { answer: synth.answer, citations },
    { status: 200 }
  );
}
