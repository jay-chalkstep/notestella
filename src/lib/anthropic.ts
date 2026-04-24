import Anthropic from '@anthropic-ai/sdk';
import type { Attendee } from '@/types';

const MODEL_ID = 'claude-opus-4-7';

// Bump whenever any prompt changes so logs can correlate output quality to prompt revisions.
export const PROMPT_VERSION = 1;

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
  "prep_notes": string[]       // optional; up to 3 bullets if genuinely useful
}

Rules:
- Never fabricate facts. If priors say nothing, say nothing.
- Never advise on tone or psychology. Surface facts and open loops.
- Prefer specificity: "Follow up on SoCalGas scope changes from 4/12" > "Discuss project status".
- If the meeting has no priors, set open_threads to [] and say so in context briefly.`;

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

export type BriefInput = {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  attendees: Attendee[];
  description?: string;
  priors: PriorMeeting[];
};

export type BriefOutput = {
  context: string;
  agenda_suggestions: string[];
  open_threads: string[];
  questions_to_ask: string[];
  prep_notes: string[];
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

  return `Meeting: ${input.title}
Date: ${input.date} ${input.startTime}-${input.endTime} MT
Attendees: ${formatAttendees(input.attendees)}
Description: ${input.description ?? '(none)'}

Prior meetings in this series (most recent first, up to 5):
${priorsBlock}

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
