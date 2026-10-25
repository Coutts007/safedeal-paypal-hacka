import { secureCookies } from "@/lib/accounts/http";
import { newState, stateCookie } from "@/lib/accounts/session";
import { serverEnv } from "@/lib/env";
import { connectUrl } from "@/lib/paypal/identity";

export const dynamic = "force-dynamic";

/** "Log in with PayPal": send the browser to PayPal's sign-in page with a fresh `state`. */
export function GET() {
  const env = serverEnv();
  const state = newState();
  const res = new Response(null, {
    status: 302,
    headers: {
      Location: connectUrl({
        connectBase: env.PAYPAL_CONNECT_URL,
        clientId: env.PAYPAL_CLIENT_ID,
        redirectUri: `${env.APP_BASE_URL}/api/auth/paypal/callback`,
        state,
      }),
      "Cache-Control": "no-store",
    },
  });
  res.headers.append("Set-Cookie", stateCookie(state, secureCookies()));
  return res;
}
