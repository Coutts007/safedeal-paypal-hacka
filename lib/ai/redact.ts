// Replace personal data in chat text with tokens such as [PHONE_1] before any text leaves the
// server (BUILD_PLAN 8.3). The same value always gets the same token within one chat, so the AI
// can still tell that two messages mention the same number.

export type RedactionKind = "EMAIL" | "CARD" | "MPESA" | "PHONE";

export type Redacted = { text: string; counts: Record<RedactionKind, number> };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13 to 19 digits, optionally grouped by spaces or dashes; kept only if the Luhn check passes.
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
// M-PESA transaction codes: 10 upper-case letters and digits, with both letters and digits.
const MPESA = /\b(?=[A-Z0-9]*\d[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z][A-Z0-9]*[A-Z])[A-Z][A-Z0-9]{9}\b/g;
// Kenyan mobile and landline numbers: +254 / 254 / 0, then 7xx or 1xx, then 6 digits.
const PHONE = /(?<![\d+])(?:\+?254[\s-]?|0)[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redact(input: string): Redacted {
  const counts: Record<RedactionKind, number> = { EMAIL: 0, CARD: 0, MPESA: 0, PHONE: 0 };
  const seen = new Map<string, string>();
  const token = (kind: RedactionKind, raw: string) => {
    const key = `${kind}:${kind === "EMAIL" ? raw.toLowerCase() : raw.replace(/\D/g, "") || raw}`;
    let t = seen.get(key);
    if (!t) {
      counts[kind] += 1;
      t = `[${kind}_${counts[kind]}]`;
      seen.set(key, t);
    }
    return t;
  };

  let text = input.replace(EMAIL, (m) => token("EMAIL", m));
  text = text.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? token("CARD", m) : m));
  text = text.replace(MPESA, (m) => token("MPESA", m));
  text = text.replace(PHONE, (m) => token("PHONE", normalisePhone(m)));
  return { text, counts };
}

/** 0712 345 678, +254712345678 and 254 712-345-678 are the same number. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("254") ? digits.slice(3) : digits.slice(1);
}
