import Anthropic from '@anthropic-ai/sdk';
import type { Attendee } from '@/types';
import type { CustomerLensData, SellerLensData, ExecutiveLensData } from '@/lib/hubspot';

const MODEL_ID = 'claude-opus-4-7';

// Bump whenever any prompt changes so logs can correlate output quality to prompt revisions.
export const PROMPT_VERSION = 5;

// No cache_control: Opus 4.7 minimum cacheable prefix is 4096 tokens; these prompts are
// ~750 tokens each, so cache_control would be a silent no-op. At ~10 calls/morning the
// economics don't justify growing the prompt to hit the threshold.

export const MEETING_BRIEF_SYSTEM = `You generate meeting briefs for a CEO preparing on a reMarkable Pro tablet.
Output JSON only. No markdown fences, no preamble.

Required shape:
{
  "context": string,           // 2-4 sentences: why this meeting matters given priors
  "agenda_suggestions": string[], // 3-6 bullets, imperative voice
  "open_threads": string[],    // things carried over from prior meetings in this series
  "questions_to_ask": string[], // 3-5 sharp questions
  "prep_notes": string[],      // optional; up to 3 bullets if genuinely useful
  "crm_section": {
    "lens": "customer" | "seller" | "sales_leader" | "none",
    "facts": string[],         // raw factual bullets, no interpretation
    "flags": string[]          // anomalies worth noticing, still factual
  } | null
}

Rules:
- Never fabricate facts. If priors say nothing, say nothing.
- Never advise on tone or psychology. Surface facts and open loops.
- Prefer specificity: "Follow up on SoCalGas scope changes from 4/12" > "Discuss project status".
- If the meeting has no priors, set open_threads to [] and say so in context briefly.

CRM section:
- If crm_data is provided in the input, synthesize it into facts[] and flags[].
- If crm_data is null, set crm_section to null.
- Facts are mechanical readouts: "3 open deals totaling $420K", "Last activity on X: 14 days ago",
  "Pipeline grew $180K week-over-week".
- Flags are anomalies worth noticing, still stated as facts: "Deal at Proposal stage has no activity
  for 47 days", "Activity this week is 40% below this rep's 30-day average".
- Do not draw conclusions. Never write "X is struggling", "X is checked out", "this deal is stuck",
  "the customer is disengaged". If you find yourself wanting to write a conclusion, restate the
  underlying fact instead.
- Budget: max 6 facts and max 6 flags. Prioritize specificity over completeness.`;

export const NOTE_EXTRACTION_SYSTEM = `You are extracting handwritten notes from a meeting page.

You will see an image of a PDF page with printed meeting metadata (title, date, context, etc.)
at the top, and handwritten notes below. IGNORE the printed content completely. Only extract
handwritten annotations.

If the page has no handwritten content, return { "skipped": true } and nothing else.

Otherwise return JSON:
{
  "raw_text": string,
  "summary": string,
  "decisions": string[],
  "action_items": [{ "description": string, "owner": string | null, "due": string | null }]
}

Rules:
- Preserve the writer's actual words. Don't paraphrase raw_text.
- If handwriting is unclear, your best guess is fine. Mark uncertain words with [?].
- A "decision" is something concluded (e.g., "Ship Phase 2 next Friday").
- An "action item" is something to be done (e.g., "Ping Austin re: SoCalGas").
- Do not infer beyond what's on the page.`;

export const DAILY_OVERVIEW_SYSTEM = `You generate a daily calendar overview for a CEO's reMarkable Pro.
Output JSON only.

Shape:
{
  "shape_of_day": string,              // 2-3 sentences on the day's arc
  "watch_outs": string[],              // conflicts, tight transitions, prep-heavy meetings
  "parking_lot_prompts": string[]      // 3-5 prompts to seed the parking-lot section
}

Rules:
- No fabrication. No psychology. No advice on how to show up.
- Watch-outs are mechanical (back-to-back, double-booked, travel time).
- Parking lot prompts are generic-but-useful: "What decision am I delaying?"`;

export type PriorMeeting = {
  date: string;
  title: string;
  summary: string;
  decisions: unknown[];
  action_items: unknown[];
};

export type BriefCrmData = CustomerLensData | SellerLensData | ExecutiveLensData | null;

export type BriefInput = {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  attendees: Attendee[];
  description?: string;
  priors: PriorMeeting[];
  crmData?: BriefCrmData;
};

export type CrmSection = {
  lens: 'customer' | 'seller' | 'sales_leader' | 'none';
  facts: string[];
  flags: string[];
};

export type BriefOutput = {
  context: string;
  agenda_suggestions: string[];
  open_threads: string[];
  questions_to_ask: string[];
  prep_notes: string[];
  crm_section: CrmSection | null;
};

export type DailyOverviewInput = {
  date: string;
  meetings: Array<{
    title: string;
    startTime: string;
    endTime: string;
    attendeeCount: number;
  }>;
};

export type DailyOverviewOutput = {
  shape_of_day: string;
  watch_outs: string[];
  parking_lot_prompts: string[];
};

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

function formatAttendees(attendees: Attendee[]): string {
  if (attendees.length === 0) return '(none)';
  return attendees
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(', ');
}

function buildBriefUserMessage(input: BriefInput): string {
  const priorsBlock =
    input.priors.length === 0
      ? '(no prior meetings in this series)'
      : input.priors
          .map(
            (p) =>
              `## ${p.date} — ${p.title}\nSummary: ${p.summary}\nDecisions: ${JSON.stringify(p.decisions)}\nAction items: ${JSON.stringify(p.action_items)}\n---`
          )
          .join('\n');

  const crmBlock = input.crmData
    ? `\n\nCRM data (${input.crmData.lens} lens):\n${JSON.stringify(input.crmData, null, 2)}`
    : '';

  return `Meeting: ${input.title}
Date: ${input.date} ${input.startTime}-${input.endTime} MT
Attendees: ${formatAttendees(input.attendees)}
Description: ${input.description ?? '(none)'}

Prior meetings in this series (most recent first, up to 5):
${priorsBlock}${crmBlock}

Generate the brief.`;
}

function buildOverviewUserMessage(input: DailyOverviewInput): string {
  const meetingLines =
    input.meetings.length === 0
      ? '(no meetings)'
      : input.meetings
          .map(
            (m) =>
              `- ${m.startTime}-${m.endTime}  ${m.title}  (${m.attendeeCount} attendee${m.attendeeCount === 1 ? '' : 's'})`
          )
          .join('\n');

  return `Date: ${input.date}

Meetings:
${meetingLines}

Generate the overview.`;
}

const FENCE_RE = /^```(?:json)?\s*|\s*```$/g;

function parseJsonStrict<T>(raw: string, context: string): T {
  const cleaned = raw.trim().replace(FENCE_RE, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.error(`[anthropic] JSON parse failed for ${context}`, {
      raw,
      cleaned,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Failed to parse Claude JSON response for ${context}`);
  }
}

function extractText(content: Anthropic.ContentBlock[]): string {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text) throw new Error('Claude returned no text content');
  return text;
}

export async function generateMeetingBrief(input: BriefInput): Promise<BriefOutput> {
  const response = await getClient().messages.create({
    model: MODEL_ID,
    max_tokens: 8192,
    system: MEETING_BRIEF_SYSTEM,
    messages: [{ role: 'user', content: buildBriefUserMessage(input) }],
  });
  return parseJsonStrict<BriefOutput>(
    extractText(response.content),
    `meeting brief: ${input.title}`
  );
}

export const DAILY_REFLECTION_SYSTEM = `You generate a daily reflection for a CEO reviewing the day on a reMarkable Pro.
Output JSON only.

Shape:
{
  "day_in_review": string,           // 3-5 sentences, factual narrative of the day's arc
  "decisions_made": string[],        // pulled from notes
  "new_action_items": [{ "description": string, "owner": string | null, "due": string | null }],
  "open_threads": string[],          // items not resolved, carrying forward
  "patterns_noticed": string[],      // 0-3 observations across meetings. Patterns only, not conclusions.
  "reflective_prompt": string        // one single prompt, not a list
}

Rules (ABSOLUTE):
- Surface facts and patterns. Never conclusions.
- "Austin came up in 3 conversations today, all about SoCalGas" = pattern. OK.
- "Austin seems disengaged" = conclusion. FORBIDDEN.
- Reflective prompt is a question, not advice. "What would it take to close the SoCalGas loop this week?"
  not "You should focus on closing SoCalGas."
- If nothing rises to pattern level, return patterns_noticed: [].
- If notes are sparse, don't compensate by inflating. Short is fine.`;

export const SEARCH_SYNTHESIS_SYSTEM = `You answer a user's question about their own meeting notes.

You will receive a query and a list of notes drawn from prior meetings, each with an id (n1, n2, ...).
Answer ONLY using the provided notes. Cite the notes you relied on inline like [n1], [n3].
If the provided notes do not support an answer, say so plainly — do not guess.

Surface facts, not interpretation. Prefer direct quotes or close paraphrases over conclusions.
Keep the answer tight: 2-5 sentences for most questions, up to a short paragraph for complex ones.

Output JSON only. No markdown fences.

Shape:
{
  "answer": string,          // includes inline [n#] citations
  "cited_ids": string[]      // ["n1", "n3"] — just the ids you cited
}`;

export const WEEKLY_REFLECTION_SYSTEM = `You generate a weekly reflection for a CEO. Output JSON only.

Shape:
{
  "week_in_review": string,                // 4-6 sentences
  "recurring_people": [{ "name": string, "email": string, "count": int, "contexts": string[] }],
  "recurring_topics": [{ "topic": string, "meeting_refs": string[] }],
  "action_items_status": {
    "closed_this_week": string[],
    "still_open": string[],
    "drifting": string[]                   // open > 14 days
  },
  "hubspot_deltas": {                      // null if HubSpot data not provided
    "pipeline_change": string,             // "Pipeline +$420K WoW" style
    "deals_moved": string[],
    "deals_gone_cold": string[],
    "rep_anomalies": string[]
  } | null,
  "patterns_noticed": string[],
  "reflective_prompt": string              // one question for the week ahead
}

Rules:
- Same as daily: facts and patterns, never conclusions.
- "This rep's activity is 30% below their 30-day average" = anomaly fact. OK.
- "This rep is disengaged" = conclusion. FORBIDDEN.
- Drifting action items: list the description + age in days ("Ping Austin re: SoCalGas — 21d").`;

export type ActionItem = {
  description: string;
  owner: string | null;
  due: string | null;
};

export type NoteExtractionSkipped = { skipped: true };
export type NoteExtractionContent = {
  skipped?: false;
  raw_text: string;
  summary: string;
  decisions: string[];
  action_items: ActionItem[];
};
export type NoteExtraction = NoteExtractionSkipped | NoteExtractionContent;

export type NoteExtractionContext = { title: string; date: string };

export async function extractNotesFromImage(
  imageBase64: string,
  ctx: NoteExtractionContext
): Promise<NoteExtraction> {
  const response = await getClient().messages.create({
    model: MODEL_ID,
    max_tokens: 8192,
    system: NOTE_EXTRACTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
          },
          { type: 'text', text: `Meeting: ${ctx.title} on ${ctx.date}` },
        ],
      },
    ],
  });
  return parseJsonStrict<NoteExtraction>(
    extractText(response.content),
    `note extraction: ${ctx.title} ${ctx.date}`
  );
}

export type DailyReflectionNote = {
  meeting_id: string;
  note_id: string;
  summary: string | null;
  decisions: unknown[];
  action_items: unknown[];
};

export type DailyReflectionMeeting = {
  meeting_id: string;
  title: string;
  startTime: string;
  endTime: string;
  attendees: string[];
};

export type DailyReflectionInput = {
  date: string;
  meetings: DailyReflectionMeeting[];
  notes: DailyReflectionNote[];
};

export type DailyReflectionOutput = {
  day_in_review: string;
  decisions_made: string[];
  new_action_items: ActionItem[];
  open_threads: string[];
  patterns_noticed: string[];
  reflective_prompt: string;
};

export async function generateDailyReflection(
  input: DailyReflectionInput
): Promise<DailyReflectionOutput> {
  const response = await getClient().messages.create({
    model: MODEL_ID,
    max_tokens: 4096,
    system: DAILY_REFLECTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Date: ${input.date}

Meetings (${input.meetings.length}):
${JSON.stringify(input.meetings, null, 2)}

Notes (${input.notes.length}):
${JSON.stringify(input.notes, null, 2)}

Generate the daily reflection.`,
      },
    ],
  });
  return parseJsonStrict<DailyReflectionOutput>(
    extractText(response.content),
    `daily reflection: ${input.date}`
  );
}

export type HubspotSnapshotDelta = {
  current: {
    snapshot_date: string;
    pipeline_by_stage: unknown;
    rep_activity: unknown;
    top_open_deals: unknown;
  };
  previous: {
    snapshot_date: string;
    pipeline_by_stage: unknown;
    rep_activity: unknown;
    top_open_deals: unknown;
  } | null;
};

export type WeeklyReflectionInput = {
  period_start: string;
  period_end: string;
  meetings: DailyReflectionMeeting[];
  notes: DailyReflectionNote[];
  prior_week_meetings: DailyReflectionMeeting[];
  prior_week_notes: DailyReflectionNote[];
  hubspot: HubspotSnapshotDelta | null;
};

export type RecurringPerson = {
  name: string;
  email: string;
  count: number;
  contexts: string[];
};

export type RecurringTopic = { topic: string; meeting_refs: string[] };

export type WeeklyReflectionOutput = {
  week_in_review: string;
  recurring_people: RecurringPerson[];
  recurring_topics: RecurringTopic[];
  action_items_status: {
    closed_this_week: string[];
    still_open: string[];
    drifting: string[];
  };
  hubspot_deltas: {
    pipeline_change: string;
    deals_moved: string[];
    deals_gone_cold: string[];
    rep_anomalies: string[];
  } | null;
  patterns_noticed: string[];
  reflective_prompt: string;
};

export async function generateWeeklyReflection(
  input: WeeklyReflectionInput
): Promise<WeeklyReflectionOutput> {
  const response = await getClient().messages.create({
    model: MODEL_ID,
    max_tokens: 6144,
    system: WEEKLY_REFLECTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Week: ${input.period_start} to ${input.period_end}

This week's meetings (${input.meetings.length}):
${JSON.stringify(input.meetings, null, 2)}

This week's notes (${input.notes.length}):
${JSON.stringify(input.notes, null, 2)}

Prior week's meetings (${input.prior_week_meetings.length}):
${JSON.stringify(input.prior_week_meetings, null, 2)}

Prior week's notes (${input.prior_week_notes.length}):
${JSON.stringify(input.prior_week_notes, null, 2)}

HubSpot delta: ${input.hubspot ? JSON.stringify(input.hubspot, null, 2) : 'null'}

Generate the weekly reflection.`,
      },
    ],
  });
  return parseJsonStrict<WeeklyReflectionOutput>(
    extractText(response.content),
    `weekly reflection: ${input.period_start}`
  );
}

export type SearchCandidate = {
  ref: string;      // "n1", "n2", ...
  note_id: string;
  meeting_id: string;
  date: string;
  summary: string | null;
  raw_text: string;
};

export type SearchAnswer = {
  answer: string;
  cited_ids: string[];
};

export async function generateSearchAnswer(
  query: string,
  candidates: SearchCandidate[]
): Promise<SearchAnswer> {
  const notesBlock = candidates
    .map(
      (c) =>
        `[${c.ref}] meeting_id=${c.meeting_id} date=${c.date}\nSummary: ${c.summary ?? '(none)'}\nRaw: ${c.raw_text}\n---`
    )
    .join('\n');

  const response = await getClient().messages.create({
    model: MODEL_ID,
    max_tokens: 2048,
    system: SEARCH_SYNTHESIS_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Query: ${query}\n\nNotes:\n${notesBlock}\n\nAnswer the query.`,
      },
    ],
  });
  return parseJsonStrict<SearchAnswer>(
    extractText(response.content),
    `search answer: ${query.slice(0, 60)}`
  );
}

export async function generateDailyOverview(
  input: DailyOverviewInput
): Promise<DailyOverviewOutput> {
  const response = await getClient().messages.create({
    model: MODEL_ID,
    max_tokens: 4096,
    system: DAILY_OVERVIEW_SYSTEM,
    messages: [{ role: 'user', content: buildOverviewUserMessage(input) }],
  });
  return parseJsonStrict<DailyOverviewOutput>(
    extractText(response.content),
    `daily overview: ${input.date}`
  );
}
