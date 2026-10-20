import { serverEnv } from "@/lib/env";

// Thin PayPal REST client over fetch (no PayPal server SDK). Phase 2 adds recording of every call
// in `payment_requests`. Never logs the client secret or access token.

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
};

export async function paypalFetch<T = unknown>(
  path: string,
  { method = "GET", body, requestId }: PaypalFetchOptions = {},
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

  const res = await fetchWithRetry(`${serverEnv().PAYPAL_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as T;
  return {
    ok: res.ok,
    status: res.status,
    debugId: res.headers.get("paypal-debug-id"),
    json,
  };
}
