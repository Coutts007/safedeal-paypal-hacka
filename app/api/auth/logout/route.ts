import { clearedSessionCookie } from "@/lib/accounts/session";
import { secureCookies } from "@/lib/accounts/http";
import { json } from "@/lib/http";

/** Log the seller out of SafeDeal (their PayPal session is PayPal's own). */
export function POST() {
  const res = json({ ok: true });
  res.headers.set("Set-Cookie", clearedSessionCookie(secureCookies()));
  return res;
}
