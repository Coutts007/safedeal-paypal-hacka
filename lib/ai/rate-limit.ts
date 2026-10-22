// In-memory limits on AI extraction (plan amendment 2026-10-20): each call costs money, and the
// create page is public. One web instance on Render, so memory is enough; a restart resets it.

export type Limiter = { take: (key: string, now: number) => boolean };

/** At most `limit` calls per `windowMs` for each key (sliding window). */
export function slidingWindow(limit: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return {
    take(key, now) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Keep the map from growing without bound on a long-running instance.
      if (hits.size > 10_000) hits.delete(hits.keys().next().value as string);
      return true;
    },
  };
}

export const perClient = slidingWindow(6, 10 * 60_000);
export const perDay = slidingWindow(200, 24 * 3_600_000);

/** The caller's address as Render forwards it (first entry of x-forwarded-for). */
export function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
