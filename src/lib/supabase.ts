import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Lazy init: Next.js 16 evaluates this module during build-time "collect page data",
// and createClient throws if env vars aren't set. Defer until first use.
let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!cached) {
    cached = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
  }
  return cached;
}
