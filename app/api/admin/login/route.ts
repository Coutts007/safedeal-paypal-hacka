import { z } from "zod";
import { clientKey } from "@/lib/ai/rate-limit";
import { loginLimiter, sessionCookie, sessionValue } from "@/lib/admin/auth";
import { serverEnv } from "@/lib/env";
import { fail, json, readJson } from "@/lib/http";
import { secretMatches } from "@/lib/secrets";

const body = z.object({ password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  const env = serverEnv();
  if (!env.ADMIN_PASSWORD) return fail(503, "ADMIN_PASSWORD is not set");
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const now = new Date();
  if (!secretMatches(input.data.password, env.ADMIN_PASSWORD)) {
    // Only wrong passwords count towards the limit.
    if (!loginLimiter.take(clientKey(req), now.getTime())) {
      return fail(429, "too many wrong passwords; wait 15 minutes");
    }
    return fail(401, "wrong password");
  }
  const res = json({ ok: true });
  res.headers.set(
    "Set-Cookie",
    sessionCookie(sessionValue(env.ADMIN_PASSWORD, now), env.APP_BASE_URL.startsWith("https:")),
  );
  return res;
}
