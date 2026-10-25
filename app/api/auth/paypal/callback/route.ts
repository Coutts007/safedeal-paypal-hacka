import { secureCookies } from "@/lib/accounts/http";
import { loginAccount } from "@/lib/accounts/service";
import {
  clearedStateCookie,
  sessionCookie,
  sessionKey,
  sessionValue,
  STATE_COOKIE,
  stateMatches,
} from "@/lib/accounts/session";
import { cookieFrom } from "@/lib/admin/auth";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { profileFromCode } from "@/lib/paypal/identity";

export const dynamic = "force-dynamic";

/** Where PayPal sends the seller back: check `state`, read the profile, start a session. */
export async function GET(req: Request) {
  const env = serverEnv();
  const url = new URL(req.url);
  const secure = secureCookies();
  const go = (path: string, session?: string) => {
    const res = new Response(null, {
      status: 302,
      headers: { Location: `${env.APP_BASE_URL}${path}`, "Cache-Control": "no-store" },
    });
    res.headers.append("Set-Cookie", clearedStateCookie(secure));
    if (session) res.headers.append("Set-Cookie", sessionCookie(session, secure));
    return res;
  };

  const code = url.searchParams.get("code");
  if (!code) return go("/login?error=cancelled");
  // A login this browser did not start (or one older than 10 minutes) is refused.
  if (
    !stateMatches(
      url.searchParams.get("state"),
      cookieFrom(req.headers.get("cookie"), STATE_COOKIE),
    )
  ) {
    return go("/login?error=expired");
  }
  const profile = await profileFromCode({
    apiBase: env.PAYPAL_API_BASE,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    code,
  });
  if (!profile.ok) {
    console.warn(`Log in with PayPal failed: ${profile.reason}`);
    return go(profile.reason.includes("email") ? "/login?error=email" : "/login?error=paypal");
  }
  const now = new Date();
  const { account } = await loginAccount(getDb(), profile.value, now);
  return go("/dashboard", sessionValue(sessionKey(env.PAYPAL_CLIENT_SECRET), account.id, now));
}
