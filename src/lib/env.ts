import { z } from 'zod';

// Validate at request time (not module load) — `next build` evaluates modules
// in CI where envs may be unset. Each cron route's `run()` calls `getEnv()`
// early; the first failed cron after a deploy gives a clean error message
// listing every missing/malformed key, instead of dying mid-request with a
// `Resend send failed: invalid api key`.
const EnvSchema = z
  .object({
    // Required for every cron run.
    ANTHROPIC_API_KEY: z.string().min(1),
    CRON_SECRET: z.string().min(20),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    VOYAGE_API_KEY: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_REFRESH_TOKEN: z.string().min(1),
    RESEND_API_KEY: z.string().min(1),
    RESEND_FROM_ADDRESS: z.string().email(),
    REMARKABLE_EMAIL: z.string().email(),
    NOTESTELLA_READ_SECRET: z.string().min(20),

    // Optional.
    GOOGLE_CALENDAR_ID: z.string().optional(),
    MY_EMAIL: z.string().email().optional(),
    HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.HUBSPOT_PRIVATE_APP_TOKEN && !env.MY_EMAIL) {
      ctx.addIssue({
        code: 'custom',
        path: ['MY_EMAIL'],
        message:
          'MY_EMAIL is required when HUBSPOT_PRIVATE_APP_TOKEN is set (lens selection needs it to identify external attendees)',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  cached = result.data;
  return cached;
}

// Test-only: clears the memoized env so a test can mutate process.env between
// cases. Not exported via barrel; production code never calls this.
export function __resetEnvCache(): void {
  cached = null;
}
