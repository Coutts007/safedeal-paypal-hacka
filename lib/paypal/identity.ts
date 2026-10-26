import { z } from "zod";
import { networkErrorReason } from "./client";

// Log in with PayPal (Phase 6b; developer.paypal.com/log-in/build). The seller signs in on PayPal's
// own page; PayPal sends back a one-time code; SafeDeal exchanges it for a user access token and
// reads the profile once. The token is used for that one call and never stored. These calls are not
// written to `payment_requests`: the profile is personal data and moves no money.

/** openid: the PayPal user id; profile: name; email; paypalattributes: payer id, verified flag. */
export const LOGIN_SCOPES = "openid profile email https://uri.paypal.com/services/paypalattributes";

export function connectUrl(opts: {
  connectBase: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    flowEntry: "static",
    client_id: opts.clientId,
    response_type: "code",
    scope: LOGIN_SCOPES,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    // Same tab instead of a mini window: works the same on phones and avoids popup blockers.
    fullPage: "true",
  });
  // Spaces as %20, as in PayPal's own button code (URLSearchParams would write "+").
  return `${opts.connectBase}?${q.toString().replaceAll("+", "%20")}`;
}

export type PaypalProfile = {
  paypalUserId: string;
  email: string;
  name: string | null;
  payerId: string | null;
  verifiedAccount: boolean | null;
};

const flag = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : v === "true"));

// Both shapes PayPal documents: `schema=paypalv1.1` (emails[] with primary/confirmed) and
// OpenID (`sub`, `email`, `email_verified`).
const userinfoSchema = z.object({
  user_id: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
  name: z.string().optional(),
  payer_id: z.string().optional(),
  verified_account: flag.optional(),
  email: z.string().optional(),
  emails: z
    .array(
      z.object({
        value: z.string(),
        primary: flag.optional(),
        confirmed: flag.optional(),
      }),
    )
    .optional(),
});

/** The parts of PayPal's userinfo answer SafeDeal keeps, or a reason it cannot log the user in. */
export function parseUserinfo(
  json: unknown,
): { ok: true; profile: PaypalProfile } | { ok: false; reason: string } {
  const parsed = userinfoSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "unexpected userinfo answer" };
  const u = parsed.data;
  const id = u.user_id ?? u.sub;
  if (!id) return { ok: false, reason: "PayPal did not share a user id" };
  const emails = u.emails ?? [];
  const best =
    emails.find((e) => e.primary && e.confirmed) ??
    emails.find((e) => e.primary) ??
    emails.find((e) => e.confirmed) ??
    emails[0];
  const email = (best?.value ?? u.email ?? "").trim().toLowerCase();
  if (!z.email().safeParse(email).success) {
    return { ok: false, reason: "PayPal did not share an email address" };
  }
  return {
    ok: true,
    profile: {
      paypalUserId: id,
      email,
      name: u.name?.trim() || null,
      payerId: u.payer_id ?? null,
      verifiedAccount: u.verified_account ?? null,
    },
  };
}

export type IdentityResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const TIMEOUT_MS = 15_000;

async function call(url: string, init: RequestInit): Promise<IdentityResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, reason: `PayPal unreachable (${networkErrorReason(e)})` };
  }
  const debugId = res.headers.get("paypal-debug-id") ?? "n/a";
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}${await errorName(res)} (debug_id ${debugId})` };
  }
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false, reason: `unreadable answer (debug_id ${debugId})` };
  }
}

/**
 * PayPal's error code from a refusal (`error` or `name`) and its short description, never the rest
 * of the body.
 */
async function errorName(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: unknown;
      name?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    const name = body.error ?? body.name;
    const desc = body.error_description ?? body.message;
    const code = typeof name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? ` ${name}` : "";
    const text =
      typeof desc === "string" && !desc.includes("@")
        ? ` "${desc.replace(/[^\x20-\x7e]/g, "").slice(0, 120)}"`
        : "";
    return code + text;
  } catch {
    return "";
  }
}

/** Exchange the authorization code for the user's access token, then read the profile once. */
export async function profileFromCode(opts: {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<IdentityResult<PaypalProfile>> {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const token = await call(`${opts.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code: opts.code }).toString(),
  });
  if (!token.ok) return { ok: false, reason: `code exchange failed: ${token.reason}` };
  const accessToken = (token.value as { access_token?: unknown }).access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    return { ok: false, reason: "code exchange gave no access token" };
  }
  // Scopes SafeDeal asked for but the token lacks go into any failure reason.
  const scope = (token.value as { scope?: unknown }).scope;
  const grantedScopes = typeof scope === "string" ? scope.split(" ") : [];
  const missing = LOGIN_SCOPES.split(" ").filter((s) => !grantedScopes.includes(s));
  const scopeNote = ` [missing scopes: ${missing.join(" ") || "none"}]`;
  // Content-Type as in PayPal's own userinfo example.
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // The sandbox has refused `paypalv1.1` (HTTP 400 "Unable to fetch details to serve the request")
  // and the OpenID Connect path (HTTP 401) for a valid token, so each documented address is tried in
  // turn; parseUserinfo reads both answer shapes.
  const failures: string[] = [];
  let info: IdentityResult<unknown> | undefined;
  for (const path of [
    "/v1/identity/oauth2/userinfo?schema=paypalv1.1",
    "/v1/identity/oauth2/userinfo?schema=openid",
    "/v1/identity/openidconnect/userinfo?schema=openid",
  ]) {
    const r = await call(`${opts.apiBase}${path}`, { headers });
    if (r.ok) {
      info = r;
      break;
    }
    failures.push(`${path.split("?")[1]}: ${r.reason}`);
    if (!r.reason.startsWith("HTTP 4")) break;
  }
  // Last resort: the ID token from the same code exchange. It came straight from PayPal's token
  // endpoint over TLS, authenticated with the client secret (OpenID Connect Core 3.1.3.7), so its
  // claims are PayPal's; it must name this app as its audience.
  if (!info) {
    const claims = idTokenClaims((token.value as { id_token?: unknown }).id_token, opts.clientId);
    if (claims.ok) {
      const parsed = parseUserinfo(claims.value);
      if (parsed.ok) return { ok: true, value: parsed.profile };
      // Claim names only, never values: they show what PayPal put in the token.
      const names = Object.keys(claims.value as object)
        .sort()
        .join(",");
      failures.push(`id_token: ${parsed.reason} (claims: ${names})`);
    } else {
      failures.push(`id_token: ${claims.reason}`);
    }
    return { ok: false, reason: `userinfo failed: ${failures.join("; ")}${scopeNote}` };
  }
  if (!info.ok) return info;
  const parsed = parseUserinfo(info.value);
  return parsed.ok ? { ok: true, value: parsed.profile } : parsed;
}

/** The claims of an ID token addressed to this app, or why it cannot be used. */
export function idTokenClaims(idToken: unknown, clientId: string): IdentityResult<unknown> {
  if (typeof idToken !== "string") return { ok: false, reason: "none returned" };
  const payload = idToken.split(".")[1];
  let claims: { aud?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) return { ok: false, reason: "not addressed to this app" };
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, value: claims };
}
