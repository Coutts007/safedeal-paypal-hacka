import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Handover code for deliveries without courier tracking (BUILD_PLAN section 7.1). The buyer gives
// the 6-digit code only once the item is in their hands; the seller enters it, and a correct code
// is a verified delivery.
//
// The plan asks for two things at once: store only a hash, and show the code to the buyer on every
// visit. So the code is derived (HMAC of the deal id with HANDOVER_SECRET, never stored) and only
// its hash is kept on the deal. A database copy alone reveals no codes (DECISIONS 2026-10-23).

export const HANDOVER_MAX_ATTEMPTS = 5;

/** The deal's code: same every visit, unguessable without HANDOVER_SECRET. */
export function handoverCode(dealId: string, secret: string): string {
  if (!secret) throw new Error("HANDOVER_SECRET is not set");
  const mac = createHmac("sha256", secret).update(`handover:${dealId}`).digest();
  // 48 bits mod 10^6: the bias is far below one in a million.
  return String(mac.readUIntBE(0, 6) % 1_000_000).padStart(6, "0");
}

/** What the deal row stores. Salted with the deal id so equal codes give different hashes. */
export function handoverHash(dealId: string, code: string): string {
  return createHash("sha256").update(`handover:${dealId}:${code}`).digest("hex");
}

/** Spaces and dashes are allowed when typing ("123 456"); anything else is not a code. */
export function normaliseCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** Constant-time comparison of an entered code with the stored hash. */
export function codeMatches(storedHash: string, dealId: string, input: string): boolean {
  const code = normaliseCode(input);
  if (!code) return false;
  const a = Buffer.from(handoverHash(dealId, code), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
