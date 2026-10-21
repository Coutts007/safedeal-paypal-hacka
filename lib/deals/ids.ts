import { randomBytes } from "node:crypto";

// Crockford base32 without I, L, O, U: easy to read aloud and type from a phone.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Short, unguessable reference used in links, e.g. "7K3QH9XM2C" (50 bits). */
export function newPublicRef(length = 10): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

/** Secret token in a party's link (256 bits, URL safe). */
export function newRoleToken(): string {
  return randomBytes(32).toString("base64url");
}
