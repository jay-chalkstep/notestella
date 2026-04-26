// HubSpot v3 CRM lens data for Phase 2. Uses Private App token + fetch directly.
// Batching rule: one contact search by email array, one company batch-read,
// one deal search by company-association-IN. No per-email loops.
// WoW deltas and rep anomalies (book §3.3 executive lens) are deferred to
// Phase 4 once hubspot_snapshots exists — nullable fields + TODO below.

const HS_BASE = 'https://api.hubapi.com';

function token(): string {
  const t = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!t) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not set');
  return t;
}

async function hsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let attempt = 0;
  while (true) {
    const res = await fetch(`${HS_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '2');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      attempt++;
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot ${res.status} ${path}: ${body.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }
}

// --- Types ---------------------------------------------------------------

export type Lens = 'customer' | 'seller' | 'sales_leader' | 'none';

export type CustomerLensData = {
  lens: 'customer';
  contacts: Array<{ email: string; name?: string; companyId?: string }>;
  companies: Array<{ id: string; name: string }>;
  open_deals: Array<{
    id: string;
    name: string;
    stage: string;
    amount: number | null;
    close_date?: string;
    last_activity_date?: string;
    days_since_last_activity: number | null;
    company_id?: string;
    company_name?: string;
  }>;
  stuck_deal_flags: string[];
};

export type SellerLensData = {
  lens: 'seller';
  owner_id: string;
  pipeline_by_stage: Array<{ stage: string; count: number; total_amount: number }>;
  activity_window_days: number;
  activity_count: {
    emails_logged: number;
    calls_logged: number;
    meetings_logged: number;
  };
  at_risk_deals: Array<{ deal_name: string; days_since_activity: number }>;
  // Deferred to Phase 4 (requires hubspot_snapshots for deltas):
  deals_moved_this_window: null;
  cold_accounts_30d: null;
  forecast_vs_actual: null;
};

export type ExecutiveLensData = {
  lens: 'sales_leader';
  pipeline_by_stage: Array<{ stage: string; count: number; total_amount: number }>;
  top_open_deals: Array<{
    deal_name: string;
    amount: number | null;
    stage: string;
    company_name?: string;
  }>;
  at_risk_deals: Array<{ deal_name: string; reason: string }>;
  wins_losses_window: {
    window_days: number;
    won_count: number;
    won_amount: number;
    lost_count: number;
    lost_amount: number;
  };
  // Deferred to Phase 4 (requires hubspot_snapshots):
  pipeline_wow_delta: null;
  rep_anomalies: null;
};

// --- Helpers -------------------------------------------------------------

function daysSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isClosedStage(stage: string): boolean {
  const s = stage.toLowerCase();
  return s.includes('closedwon') || s.includes('closedlost') || s.includes('closed won') || s.includes('closed lost');
}

type ContactSearchResult = {
  results: Array<{
    id: string;
    properties: Record<string, string | null>;
    associations?: {
      companies?: { results: Array<{ id: string; type: string }> };
    };
  }>;
};

type CompanyBatch = {
  results: Array<{ id: string; properties: Record<string, string | null> }>;
};

type DealSearchResult = {
  results: Array<{
    id: string;
    properties: Record<string, string | null>;
    associations?: {
      companies?: { results: Array<{ id: string; type: string }> };
    };
  }>;
};

// --- Customer lens -------------------------------------------------------

export async function getCustomerLensData(emails: string[]): Promise<CustomerLensData> {
  const empty: CustomerLensData = {
    lens: 'customer',
    contacts: [],
    companies: [],
    open_deals: [],
    stuck_deal_flags: [],
  };
  if (emails.length === 0) return empty;

  // 1) Single contact search by email IN [...].
  const contactSearch = await hsFetch<ContactSearchResult>(
    '/crm/v3/objects/contacts/search',
    {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [{ propertyName: 'email', operator: 'IN', values: emails }],
          },
        ],
        properties: ['email', 'firstname', 'lastname', 'hubspot_owner_id'],
        associations: ['companies'],
        limit: 100,
      }),
    }
  );

  const contacts = contactSearch.results.map((c) => {
    const firstCompany = c.associations?.companies?.results?.[0]?.id;
    const name = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' ').trim() || undefined;
    return {
      email: c.properties.email ?? '',
      name,
      companyId: firstCompany,
    };
  });

  const companyIds = Array.from(
    new Set(contacts.map((c) => c.companyId).filter((id): id is string => Boolean(id)))
  );

  // 2) Batch read companies.
  let companyNameById = new Map<string, string>();
  if (companyIds.length > 0) {
    const batch = await hsFetch<CompanyBatch>('/crm/v3/objects/companies/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        properties: ['name', 'domain'],
        inputs: companyIds.map((id) => ({ id })),
      }),
    });
    companyNameById = new Map(
      batch.results.map((r) => [r.id, r.properties.name ?? r.properties.domain ?? r.id])
    );
  }

  const companies = companyIds.map((id) => ({
    id,
    name: companyNameById.get(id) ?? id,
  }));

  // 3) Single deal search where associations.company IN [...].
  let openDeals: CustomerLensData['open_deals'] = [];
  const stuckFlags: string[] = [];

  if (companyIds.length > 0) {
    const dealSearch = await hsFetch<DealSearchResult>(
      '/crm/v3/objects/deals/search',
      {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'associations.company',
                  operator: 'IN',
                  values: companyIds,
                },
              ],
            },
          ],
          properties: [
            'dealname',
            'dealstage',
            'amount',
            'closedate',
            'notes_last_updated',
            'hs_lastmodifieddate',
          ],
          associations: ['companies'],
          limit: 100,
        }),
      }
    );

    openDeals = dealSearch.results
      .filter((d) => !isClosedStage(d.properties.dealstage ?? ''))
      .map((d) => {
        const lastActivity =
          d.properties.notes_last_updated ?? d.properties.hs_lastmodifieddate ?? undefined;
        const companyId = d.associations?.companies?.results?.[0]?.id;
        const companyName = companyId ? companyNameById.get(companyId) : undefined;
        const days = daysSince(lastActivity ?? undefined);
        return {
          id: d.id,
          name: d.properties.dealname ?? '(unnamed deal)',
          stage: d.properties.dealstage ?? 'unknown',
          amount: toNum(d.properties.amount),
          close_date: d.properties.closedate ?? undefined,
          last_activity_date: lastActivity,
          days_since_last_activity: days,
          company_id: companyId,
          company_name: companyName,
        };
      });

    const stuckCandidates = openDeals
      .filter(
        (d): d is typeof d & { days_since_last_activity: number } =>
          d.days_since_last_activity !== null && d.days_since_last_activity > 30
      )
      .sort((a, b) => b.days_since_last_activity - a.days_since_last_activity);
    const STUCK_CAP = 6;
    const shown = stuckCandidates.slice(0, STUCK_CAP);
    for (const deal of shown) {
      const who = deal.company_name ? ` (${deal.company_name})` : '';
      stuckFlags.push(
        `Deal "${deal.name}"${who} has no activity for ${deal.days_since_last_activity} days`
      );
    }
    if (stuckCandidates.length > STUCK_CAP) {
      stuckFlags.push(`+ ${stuckCandidates.length - STUCK_CAP} more stuck deals`);
    }
  }

  return {
    lens: 'customer',
    contacts,
    companies,
    open_deals: openDeals,
    stuck_deal_flags: stuckFlags,
  };
}

// --- Seller lens ---------------------------------------------------------

export async function getSellerLensData(
  hubspotOwnerId: string,
  windowDays = 7
): Promise<SellerLensData> {
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Owner's open deals (non-closed).
  const dealSearch = await hsFetch<DealSearchResult>(
    '/crm/v3/objects/deals/search',
    {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: 'hubspot_owner_id', operator: 'EQ', value: hubspotOwnerId },
            ],
          },
        ],
        properties: ['dealname', 'dealstage', 'amount', 'notes_last_updated', 'hs_lastmodifieddate'],
        limit: 100,
      }),
    }
  );

  type StageBucket = { stage: string; count: number; total_amount: number };
  const byStage = new Map<string, StageBucket>();
  const atRiskCandidates: SellerLensData['at_risk_deals'] = [];

  for (const d of dealSearch.results) {
    const stage = d.properties.dealstage ?? 'unknown';
    if (isClosedStage(stage)) continue;
    const amt = toNum(d.properties.amount) ?? 0;
    const bucket = byStage.get(stage) ?? { stage, count: 0, total_amount: 0 };
    bucket.count += 1;
    bucket.total_amount += amt;
    byStage.set(stage, bucket);

    const lastActivity =
      d.properties.notes_last_updated ?? d.properties.hs_lastmodifieddate ?? undefined;
    const days = daysSince(lastActivity);
    if (days !== null && days > 14) {
      atRiskCandidates.push({
        deal_name: d.properties.dealname ?? '(unnamed deal)',
        days_since_activity: days,
      });
    }
  }

  const AT_RISK_CAP = 6;
  atRiskCandidates.sort((a, b) => b.days_since_activity - a.days_since_activity);
  const atRisk = atRiskCandidates.slice(0, AT_RISK_CAP);
  if (atRiskCandidates.length > AT_RISK_CAP) {
    atRisk.push({
      deal_name: `+ ${atRiskCandidates.length - AT_RISK_CAP} more`,
      days_since_activity: 0,
    });
  }

  // Activity counts: search engagements owned by this rep within window.
  // HubSpot v3 supports /crm/v3/objects/{emails|calls|meetings}/search.
  const activityCount = await fetchOwnerActivityCounts(hubspotOwnerId, windowStart);

  return {
    lens: 'seller',
    owner_id: hubspotOwnerId,
    pipeline_by_stage: Array.from(byStage.values()),
    activity_window_days: windowDays,
    activity_count: activityCount,
    at_risk_deals: atRisk,
    deals_moved_this_window: null,
    cold_accounts_30d: null,
    forecast_vs_actual: null,
  };
}

type EngagementSearchResult = { total: number };

export async function fetchOwnerActivityCounts(
  ownerId: string,
  sinceIso: string
): Promise<SellerLensData['activity_count']> {
  const bodyFor = (timestampProp: string) => ({
    filterGroups: [
      {
        filters: [
          { propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId },
          { propertyName: timestampProp, operator: 'GTE', value: sinceIso },
        ],
      },
    ],
    limit: 1,
  });

  // Log per-endpoint failures rather than silently coercing to 0 — without
  // logging, an upstream HubSpot 5xx looks identical to "no activity" and gets
  // reported as a 100% drop vs. last week, polluting anomaly detection.
  const safeFetch = async (path: string): Promise<EngagementSearchResult> => {
    try {
      return await hsFetch<EngagementSearchResult>(path, {
        method: 'POST',
        body: JSON.stringify(bodyFor('hs_timestamp')),
      });
    } catch (err) {
      console.error('[hubspot] engagement search failed', {
        path,
        owner_id: ownerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { total: 0 };
    }
  };

  const [emails, calls, meetings] = await Promise.all([
    safeFetch('/crm/v3/objects/emails/search'),
    safeFetch('/crm/v3/objects/calls/search'),
    safeFetch('/crm/v3/objects/meetings/search'),
  ]);

  return {
    emails_logged: emails.total,
    calls_logged: calls.total,
    meetings_logged: meetings.total,
  };
}

// --- Executive lens ------------------------------------------------------

export async function getExecutiveLensData(windowDays = 7): Promise<ExecutiveLensData> {
  const windowStart = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const dealProperties = [
    'dealname',
    'dealstage',
    'amount',
    'closedate',
    'notes_last_updated',
    'hs_lastmodifieddate',
  ];

  // Two queries instead of one: an unfiltered top-100-by-amount mixes large
  // historical closed-won deals into the pipeline rollup and crowds out current
  // open deals. Filter by `hs_is_closed` (HubSpot's built-in flag) so the
  // pipeline view is open-only and won/lost counts pull from a separate
  // recently-closed-in-window query.
  const [openSearch, closedSearch] = await Promise.all([
    hsFetch<DealSearchResult>('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
            ],
          },
        ],
        properties: dealProperties,
        associations: ['companies'],
        limit: 100,
        sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }],
      }),
    }),
    hsFetch<DealSearchResult>('/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: 'hs_is_closed', operator: 'EQ', value: 'true' },
              { propertyName: 'closedate', operator: 'GTE', value: windowStart },
            ],
          },
        ],
        properties: dealProperties,
        limit: 100,
        sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
      }),
    }),
  ]);

  type StageBucket = { stage: string; count: number; total_amount: number };
  const byStage = new Map<string, StageBucket>();
  const topOpen: ExecutiveLensData['top_open_deals'] = [];
  const atRisk: ExecutiveLensData['at_risk_deals'] = [];
  let wonCount = 0;
  let wonAmount = 0;
  let lostCount = 0;
  let lostAmount = 0;

  // Company names for top-open-deals display — batch-read all referenced ids.
  const pendingCompanyIds = new Set<string>();
  for (const d of openSearch.results) {
    const companyId = d.associations?.companies?.results?.[0]?.id;
    if (companyId) pendingCompanyIds.add(companyId);
  }
  let companyNameById = new Map<string, string>();
  if (pendingCompanyIds.size > 0) {
    const batch = await hsFetch<CompanyBatch>('/crm/v3/objects/companies/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        properties: ['name'],
        inputs: Array.from(pendingCompanyIds).map((id) => ({ id })),
      }),
    });
    companyNameById = new Map(batch.results.map((r) => [r.id, r.properties.name ?? r.id]));
  }

  for (const d of openSearch.results) {
    const stage = d.properties.dealstage ?? 'unknown';
    const amt = toNum(d.properties.amount) ?? 0;
    const closeDateIso = d.properties.closedate ?? undefined;

    const bucket = byStage.get(stage) ?? { stage, count: 0, total_amount: 0 };
    bucket.count += 1;
    bucket.total_amount += amt;
    byStage.set(stage, bucket);

    const companyId = d.associations?.companies?.results?.[0]?.id;
    const companyName = companyId ? companyNameById.get(companyId) : undefined;
    const lastActivity =
      d.properties.notes_last_updated ?? d.properties.hs_lastmodifieddate ?? undefined;
    const days = daysSince(lastActivity);

    if (topOpen.length < 10) {
      topOpen.push({
        deal_name: d.properties.dealname ?? '(unnamed deal)',
        amount: toNum(d.properties.amount),
        stage,
        company_name: companyName,
      });
    }

    if (days !== null && days > 21) {
      atRisk.push({
        deal_name: d.properties.dealname ?? '(unnamed deal)',
        reason: `${days}d without activity`,
      });
    } else if (closeDateIso && new Date(closeDateIso).getTime() < Date.now()) {
      atRisk.push({
        deal_name: d.properties.dealname ?? '(unnamed deal)',
        reason: `close date ${closeDateIso.slice(0, 10)} passed`,
      });
    }
  }

  for (const d of closedSearch.results) {
    const stage = (d.properties.dealstage ?? '').toLowerCase();
    const amt = toNum(d.properties.amount) ?? 0;
    if (stage.includes('won')) {
      wonCount += 1;
      wonAmount += amt;
    } else if (stage.includes('lost')) {
      lostCount += 1;
      lostAmount += amt;
    }
  }

  return {
    lens: 'sales_leader',
    pipeline_by_stage: Array.from(byStage.values()),
    top_open_deals: topOpen,
    at_risk_deals: atRisk,
    wins_losses_window: {
      window_days: windowDays,
      won_count: wonCount,
      won_amount: wonAmount,
      lost_count: lostCount,
      lost_amount: lostAmount,
    },
    pipeline_wow_delta: null,
    rep_anomalies: null,
  };
}
