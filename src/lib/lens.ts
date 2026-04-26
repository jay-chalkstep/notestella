import { getSupabase } from '@/lib/supabase';
import type { Attendee } from '@/types';
import type { Lens } from '@/lib/hubspot';

export type LensSelection = {
  lens: Lens;
  focusPersonEmail?: string;
  focusPersonOwnerId?: string;
};

export type PersonRow = {
  email: string;
  role: 'customer' | 'seller' | 'sales_leader' | 'other';
  hubspot_owner_id: string | null;
  notes: string | null;
};

export type PeopleMap = Map<string, PersonRow>;

export async function loadPeople(emails: string[]): Promise<PeopleMap> {
  const unique = Array.from(new Set(emails.map((e) => e.toLowerCase())));
  if (unique.length === 0) return new Map();
  const { data, error } = await getSupabase()
    .from('people')
    .select('email, role, hubspot_owner_id, notes')
    .in('email', unique);
  if (error) throw new Error(`people lookup: ${error.message}`);
  return new Map(
    (data ?? []).map((r) => [(r.email as string).toLowerCase(), r as PersonRow])
  );
}

// Caller-supplies-people variant — lets the caller batch a single lookup across
// many meetings. Pass the union of external attendee emails into loadPeople()
// once at the top of a cron run, then call this per-meeting.
export function selectLensWith(
  attendees: Attendee[],
  myEmail: string,
  people: PeopleMap
): LensSelection {
  const me = myEmail.toLowerCase();
  const others = attendees.filter((a) => a.email.toLowerCase() !== me);

  if (others.length === 0) return { lens: 'none' };

  const isOneOnOne = attendees.length === 2 && others.length === 1;

  if (isOneOnOne) {
    const other = others[0];
    const row = people.get(other.email.toLowerCase());
    if (row?.role === 'sales_leader') {
      return { lens: 'sales_leader', focusPersonEmail: other.email };
    }
    if (row?.role === 'seller') {
      return {
        lens: 'seller',
        focusPersonEmail: other.email,
        focusPersonOwnerId: row.hubspot_owner_id ?? undefined,
      };
    }
  }

  // Joint calls (customer + seller both present) → customer lens per §3.4.
  const hasExternalOrCustomer = others.some((a) => {
    const row = people.get(a.email.toLowerCase());
    return !row || row.role === 'customer';
  });
  if (hasExternalOrCustomer) return { lens: 'customer' };

  return { lens: 'none' };
}

// Convenience wrapper — loads people on demand. Use for one-off callers; use
// selectLensWith() in a loop to amortize the Supabase round-trip.
export async function selectLens(
  attendees: Attendee[],
  myEmail: string
): Promise<LensSelection> {
  const me = myEmail.toLowerCase();
  const others = attendees.filter((a) => a.email.toLowerCase() !== me);
  const emails = others.map((a) => a.email);
  const people = await loadPeople(emails);
  return selectLensWith(attendees, myEmail, people);
}
