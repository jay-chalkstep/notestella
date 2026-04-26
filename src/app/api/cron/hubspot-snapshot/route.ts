import { formatInTimeZone } from 'date-fns-tz';
import { getSupabase } from '@/lib/supabase';
import { getExecutiveLensData, fetchOwnerActivityCounts } from '@/lib/hubspot';
import { getEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TZ = 'America/Denver';
const ACTIVITY_WINDOW_DAYS = 7;

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function bearerOk(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

type SellerRow = {
  email: string;
  display_name: string | null;
  hubspot_owner_id: string | null;
};

type RepActivityEntry = {
  email: string;
  display_name: string | null;
  window_days: number;
  emails_logged: number;
  calls_logged: number;
  meetings_logged: number;
};

type RepActivityMap = Record<string, RepActivityEntry>;

async function loadSellers(): Promise<SellerRow[]> {
  const { data, error } = await getSupabase()
    .from('people')
    .select('email, display_name, hubspot_owner_id')
    .eq('role', 'seller')
    .not('hubspot_owner_id', 'is', null);
  if (error) throw new Error(`sellers query: ${error.message}`);
  return (data ?? []) as SellerRow[];
}

async function buildRepActivity(
  sellers: SellerRow[],
  sinceIso: string
): Promise<{ rep_activity: RepActivityMap; failures: string[] }> {
  const failures: string[] = [];
  // Parallel fetch across sellers. Each seller runs 3 parallel engagement
  // searches internally, so this is 3N concurrent HubSpot requests total.
  // HubSpot's Private App limit is 100/10s — typical teams of 5-10 sellers
  // (15-30 parallel calls) are well under the cap. Serialize across sellers
  // only if you expect a team of 30+.
  const results = await Promise.allSettled(
    sellers.map(async (s) => {
      if (!s.hubspot_owner_id) return null;
      const counts = await fetchOwnerActivityCounts(s.hubspot_owner_id, sinceIso);
      return {
        ownerId: s.hubspot_owner_id,
        entry: {
          email: s.email,
          display_name: s.display_name,
          window_days: ACTIVITY_WINDOW_DAYS,
          ...counts,
        } satisfies RepActivityEntry,
      };
    })
  );

  const rep_activity: RepActivityMap = {};
  results.forEach((r, i) => {
    const seller = sellers[i];
    if (r.status === 'fulfilled' && r.value) {
      rep_activity[r.value.ownerId] = r.value.entry;
    } else if (r.status === 'rejected') {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failures.push(`${seller.email}: ${reason}`);
      console.error('[hubspot-snapshot] seller activity fetch failed', {
        email: seller.email,
        owner_id: seller.hubspot_owner_id,
        error: reason,
      });
    }
  });
  return { rep_activity, failures };
}

async function run(req: Request): Promise<Response> {
  if (!bearerOk(req)) return unauthorized();
  getEnv();

  const now = new Date();
  const snapshotDate = formatInTimeZone(now, TZ, 'yyyy-MM-dd');
  const sinceIso = new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86_400_000).toISOString();

  const [exec, sellers] = await Promise.all([getExecutiveLensData(), loadSellers()]);

  const { rep_activity, failures } = await buildRepActivity(sellers, sinceIso);

  const { error } = await getSupabase()
    .from('hubspot_snapshots')
    .upsert(
      {
        snapshot_date: snapshotDate,
        pipeline_by_stage: exec.pipeline_by_stage,
        rep_activity,
        top_open_deals: exec.top_open_deals,
        raw: { exec, rep_activity_window_days: ACTIVITY_WINDOW_DAYS },
      },
      { onConflict: 'snapshot_date' }
    );
  if (error) {
    return Response.json({ error: `snapshot upsert: ${error.message}` }, { status: 500 });
  }

  const partial = failures.length > 0;
  return Response.json(
    {
      snapshot_date: snapshotDate,
      pipeline_stage_count: exec.pipeline_by_stage.length,
      top_open_deal_count: exec.top_open_deals.length,
      seller_count: sellers.length,
      rep_activity_count: Object.keys(rep_activity).length,
      failures: failures.length > 0 ? failures : undefined,
    },
    { status: partial ? 207 : 200 }
  );
}

export async function GET(req: Request): Promise<Response> {
  return run(req);
}

export async function POST(req: Request): Promise<Response> {
  return run(req);
}
