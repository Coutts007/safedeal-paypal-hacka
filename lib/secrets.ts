import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time check of a shared secret from a header. An unset expected secret never matches. */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hex HMAC-SHA256 of a raw request body. */
export function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}
