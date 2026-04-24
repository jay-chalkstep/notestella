import { getSupabase } from '@/lib/supabase';
import type { Attendee } from '@/types';
import type { Lens } from '@/lib/hubspot';

export type LensSelection = {
  lens: Lens;
  focusPersonEmail?: string;
  focusPersonOwnerId?: string;
};

type PersonRow = {
  email: string;
  role: 'customer' | 'seller' | 'sales_leader' | 'other';
  hubspot_owner_id: string | null;
};

async function loadPeople(emails: string[]): Promise<Map<string, PersonRow>> {
  if (emails.length === 0) return new Map();
  const { data, error } = await getSupabase()
    .from('people')
    .select('email, role, hubspot_owner_id')
    .in('email', emails);
  if (error) throw new Error(`people lookup: ${error.message}`);
  return new Map(
    (data ?? []).map((r) => [(r.email as string).toLowerCase(), r as PersonRow])
  );
}

export async function selectLens(
  attendees: Attendee[],
  myEmail: string
): Promise<LensSelection> {
  const me = myEmail.toLowerCase();
  const others = attendees.filter((a) => a.email.toLowerCase() !== me);

  if (others.length === 0) return { lens: 'none' };

  const emails = others.map((a) => a.email.toLowerCase());
  const people = await loadPeople(emails);

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
