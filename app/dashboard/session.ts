import { cookies } from "next/headers";
import { SELLER_COOKIE, sessionKey } from "@/lib/accounts/session";
import { sessionAccount } from "@/lib/accounts/service";
import { getDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";

/** For seller pages (server components): the logged-in seller's account, or null. */
export async function currentAccount() {
  return sessionAccount(
    getDb(),
    (await cookies()).get(SELLER_COOKIE)?.value,
    sessionKey(serverEnv().PAYPAL_CLIENT_SECRET),
    new Date(),
  );
}
