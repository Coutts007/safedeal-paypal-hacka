import { cookieFrom } from "@/lib/admin/auth";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { fail } from "@/lib/http";
import { sessionAccount } from "./service";
import { SELLER_COOKIE, sessionKey } from "./session";

/** The logged-in seller for an API request, or null (no cookie, expired, or unknown account). */
export async function accountFromRequest(req: Request) {
  const env = serverEnv();
  return sessionAccount(
    getDb(),
    cookieFrom(req.headers.get("cookie"), SELLER_COOKIE),
    sessionKey(env.PAYPAL_CLIENT_SECRET),
    new Date(),
  );
}

/**
 * Seller API guard: a valid session, and for POSTs a JSON body (another site cannot send JSON with
 * the seller's cookie without a CORS preflight we never allow).
 */
export async function requireSeller(req: Request) {
  if (req.method === "POST" && !req.headers.get("content-type")?.startsWith("application/json")) {
    return { ok: false as const, response: fail(415, "send JSON") };
  }
  const account = await accountFromRequest(req);
  if (!account) return { ok: false as const, response: fail(401, "log in with PayPal first") };
  return { ok: true as const, account };
}

/** Is the app served over https (cookies then get the Secure flag)? */
export const secureCookies = () => serverEnv().APP_BASE_URL.startsWith("https:");
