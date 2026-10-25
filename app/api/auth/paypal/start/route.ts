import { secureCookies } from "@/lib/accounts/http";
import { newState, stateCookie } from "@/lib/accounts/session";
import { serverEnv } from "@/lib/env";
import { connectUrl } from "@/lib/paypal/identity";

export const dynamic = "force-dynamic";

/**
 * "Log in with PayPal": a fresh `state` cookie and the address of PayPal's sign-in page, which the
 * button then opens. POST with JSON only, never a GET redirect: a link on this site that bounces
 * straight to a PayPal login looked like a phishing redirector to Google Safe Browsing.
 */
export function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json({ error: "expected JSON" }, { status: 415 });
  }
  const env = serverEnv();
  const state = newState();
  const res = Response.json(
    {
      url: connectUrl({
        connectBase: env.PAYPAL_CONNECT_URL,
        clientId: env.PAYPAL_CLIENT_ID,
        redirectUri: `${env.APP_BASE_URL}/api/auth/paypal/callback`,
        state,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.headers.append("Set-Cookie", stateCookie(state, secureCookies()));
  return res;
}
