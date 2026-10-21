import { serverEnv } from "@/lib/env";

// Thin PayPal REST client over fetch (no PayPal server SDK). Calls made with `record` are passed to
// the installed recorder (the app stores them in `payment_requests`). Never logs the client secret
// or access token.

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | undefined;

/** Refresh this many ms before PayPal's stated expiry. */
const TOKEN_SKEW_MS = 60_000;

/** Network-level retries (no HTTP response at all). Waits before attempts 2 and 3. */
const RETRY_DELAYS_MS = [1_000, 3_000];

/** Short reason for a failed fetch, e.g. "ETIMEDOUT" or "ECONNRESET". Never contains secrets. */
export function networkErrorReason(e: unknown): string {
  const cause = e instanceof Error ? (e.cause as { code?: string; errors?: unknown[] }) : undefined;
  const codes = (cause?.errors ?? [cause])
    .map((x) => (x as { code?: string } | undefined)?.code)
    .filter(Boolean);
  return codes.length ? [...new Set(codes)].join("/") : e instanceof Error ? e.message : String(e);
}

/**
 * fetch with retries on network errors only; any HTTP response is returned as is. Safe for POSTs
 * because each one carries a fixed PayPal-Request-Id, so a repeat replays instead of re-running.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new Error(
          `PayPal unreachable after ${attempt + 1} attempts (${networkErrorReason(e)})`,
          { cause: e },
        );
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

function basicAuth(): string {
  const env = serverEnv();
  return Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64");
}

async function postToken(body: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetchWithRetry(`${serverEnv().PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const debugId = res.headers.get("paypal-debug-id") ?? "n/a";
    throw new Error(`PayPal OAuth failed with HTTP ${res.status} (debug_id ${debugId})`);
  }
  return (await res.json()) as { access_token: string; expires_in: number };
}

export async function getAccessToken(now: () => number = Date.now): Promise<string> {
  if (tokenCache && now() < tokenCache.expiresAt) return tokenCache.token;
  const json = await postToken("grant_type=client_credentials");
  tokenCache = {
    token: json.access_token,
    expiresAt: now() + json.expires_in * 1000 - TOKEN_SKEW_MS,
  };
  return tokenCache.token;
}

/** Browser-safe token for SDK v6 `createInstance({ clientToken })`. */
export async function getClientToken(): Promise<string> {
  const json = await postToken(
    "grant_type=client_credentials&response_type=client_token&intent=sdk_init",
  );
  return json.access_token;
}

/** Test hook: forget the cached token. */
export function resetTokenCache(): void {
  tokenCache = undefined;
}

export type PaypalResponse<T = unknown> = {
  ok: boolean;
  status: number;
  /** PayPal's debug id, present on most responses; quote it when asking PayPal for help. */
  debugId: string | null;
  json: T;
};

export type PaypalFetchOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Required on every POST: a fixed key so retries never repeat a money movement. */
  requestId?: string;
  /** Pass to have the call recorded (deal id may be null for calls not tied to a deal). */
  record?: { dealId: string | null; action: string };
};

export type PaypalCallRecord = {
  dealId: string | null;
  action: string;
  method: string;
  path: string;
  requestId: string | null;
  /** Null when PayPal could not be reached. */
  status: number | null;
  json: unknown;
  debugId: string | null;
};

export type PaypalRecorder = (call: PaypalCallRecord) => Promise<void>;

let recorder: PaypalRecorder | undefined;

/** Install (or with undefined, remove) the function that stores recorded calls. */
export function setPaypalRecorder(fn: PaypalRecorder | undefined): void {
  recorder = fn;
}

async function recordCall(call: PaypalCallRecord): Promise<void> {
  if (!recorder) return;
  try {
    await recorder(call);
  } catch (e) {
    // A failed write must not hide the PayPal result; the caller still gets it.
    console.error(
      `Could not record PayPal call ${call.method} ${call.path}:`,
      (e as Error).message,
    );
  }
}

export async function paypalFetch<T = unknown>(
  path: string,
  { method = "GET", body, requestId, record }: PaypalFetchOptions = {},
): Promise<PaypalResponse<T>> {
  if (method !== "GET" && !requestId) {
    throw new Error(`PayPal ${method} ${path} needs a PayPal-Request-Id`);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await getAccessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (requestId) headers["PayPal-Request-Id"] = requestId;

  const base = record && { ...record, method, path, requestId: requestId ?? null };
  let res: Response;
  try {
    res = await fetchWithRetry(`${serverEnv().PAYPAL_API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (base) await recordCall({ ...base, status: null, json: null, debugId: null });
    throw e;
  }
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as T;
  const debugId = res.headers.get("paypal-debug-id");
  if (base) await recordCall({ ...base, status: res.status, json, debugId });
  return { ok: res.ok, status: res.status, debugId, json };
}
