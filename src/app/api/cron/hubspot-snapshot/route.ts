import { formatInTimeZone } from 'date-fns-tz';
import { getSupabase } from '@/lib/supabase';
import { getExecutiveLensData } from '@/lib/hubspot';

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
  const snapshotDate = formatInTimeZone(now, TZ, 'yyyy-MM-dd');

  const exec = await getExecutiveLensData();

  // rep_activity is left empty for now — populating it requires iterating the
  // sellers list from the people table and making N*3 engagement searches.
  // The weekly reflection's rep_anomalies depends on this — when that becomes
  // active, compute rep_activity here first.
  const rep_activity = {};

  const { error } = await getSupabase()
    .from('hubspot_snapshots')
    .upsert(
      {
        snapshot_date: snapshotDate,
        pipeline_by_stage: exec.pipeline_by_stage,
        rep_activity,
        top_open_deals: exec.top_open_deals,
        raw: exec,
      },
      { onConflict: 'snapshot_date' }
    );
  if (error) {
    return Response.json({ error: `snapshot upsert: ${error.message}` }, { status: 500 });
  }

  return Response.json(
    {
      snapshot_date: snapshotDate,
      pipeline_stage_count: exec.pipeline_by_stage.length,
      top_open_deal_count: exec.top_open_deals.length,
    },
    { status: 200 }
  );
}
