import { z } from "zod";

// Server-side environment. Parsed lazily so tests and build steps that do not
// need a variable are not forced to set it. Values are never logged.
const serverEnvSchema = z.object({
  PAYPAL_ENV: z.enum(["sandbox"]).default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PAYPAL_WEBHOOK_ID: z.string().default(""),
  PAYPAL_API_BASE: z.string().url().default("https://api-m.sandbox.paypal.com"),
  DATABASE_URL: z.string().min(1),
  LLM_PROVIDER: z.string().default("anthropic"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("claude-sonnet-5-5"),
  COURIER_MODE: z.enum(["test", "aftership"]).default("test"),
  AFTERSHIP_API_KEY: z.string().default(""),
  AFTERSHIP_WEBHOOK_SECRET: z.string().default(""),
  TEST_COURIER_SECRET: z.string().default(""),
  CRON_SECRET: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  DEMO_TIME_SCALE: z.coerce.number().positive().default(1),
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  KES_PER_USD: z.coerce.number().positive().default(130),
  MAX_DEAL_USD: z.coerce.number().positive().max(10_000).default(500),
  SANDBOX_SELLER_A_EMAIL: z.string().default(""),
  SANDBOX_SELLER_B_EMAIL: z.string().default(""),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

type EnvSource = Record<string, string | undefined>;

/** Strip trailing inline comments like `test   # test | aftership` that dotenv keeps. */
function clean(source: EnvSource): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = v === undefined ? undefined : v.replace(/\s+#.*$/, "").trim() || undefined;
  }
  return out;
}

export function parseServerEnv(source: EnvSource): ServerEnv {
  const result = serverEnvSchema.safeParse(clean(source));
  if (!result.success) {
    // Report variable names only, never values.
    const names = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${names}`);
  }
  if (result.data.PAYPAL_API_BASE.includes("api-m.paypal.com")) {
    throw new Error("Live PayPal API base is not allowed. SafeDeal runs on the sandbox only.");
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
