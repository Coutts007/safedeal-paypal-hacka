import { cookies } from "next/headers";
import { ADMIN_COOKIE, validSession } from "@/lib/admin/auth";
import { serverEnv } from "@/lib/env";

/** For admin pages (server components): is this browser logged in? */
export async function isAdmin(): Promise<boolean> {
  const password = serverEnv().ADMIN_PASSWORD;
  return validSession((await cookies()).get(ADMIN_COOKIE)?.value, password, new Date());
}

export const REVIEW_KIND: Record<string, string> = {
  deliver_by: "Delivery date passed",
  day_26: "Day 26 of the PayPal hold",
  buyer_problem: "Buyer reported a problem",
  paypal: "PayPal problem",
  other: "Other",
};
