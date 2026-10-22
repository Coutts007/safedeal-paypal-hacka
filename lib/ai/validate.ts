import { z } from "zod";
import type { ChatMessage } from "./chat";
import { extractionSchema, SOURCED_FIELDS, type Extraction } from "./schema";

// Checks the model's output beyond its JSON shape. Any problem means: retry once with the list of
// problems, then fall back to an empty card the seller fills by hand (BUILD_PLAN 8.3).

const isoWithOffset = z.iso.datetime({ offset: true });

export type ValidationResult = { ok: true; value: Extraction } | { ok: false; problems: string[] };

export function validateExtraction(raw: unknown, messages: ChatMessage[]): ValidationResult {
  const parsed = extractionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`),
    };
  }
  const x = parsed.data;
  const ids = new Set(messages.map((m) => m.id));
  const problems: string[] = [];
  const checkSources = (path: string, list: string[]) => {
    for (const id of list) if (!ids.has(id)) problems.push(`${path}: unknown message id "${id}"`);
  };

  for (const f of SOURCED_FIELDS) checkSources(`${f}.sources`, x[f].sources);
  x.conditions.forEach((c, i) => checkSources(`conditions[${i}].sources`, c.sources));
  for (const flag of x.instruction_flags) checkSources("instruction_flags", [flag.message_id]);

  if (x.item.value !== null && !x.item.value.trim()) problems.push("item.value: empty string");
  if (x.item.value && x.item.value.length > 127) problems.push("item.value: over 127 characters");
  if (x.quantity.value !== null && (x.quantity.value < 1 || x.quantity.value > 1000)) {
    problems.push("quantity.value: must be between 1 and 1000");
  }
  if (x.price.amount !== null) {
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(x.price.amount)) {
      problems.push('price.amount: must be a plain decimal such as "12000.00"');
    }
    if (x.price.currency === null) problems.push("price.currency: required when amount is set");
  }
  for (const f of ["ship_by", "deliver_by"] as const) {
    const v = x[f].value;
    if (v !== null && !isoWithOffset.safeParse(v).success) {
      problems.push(`${f}.value: must be ISO-8601 with an offset, e.g. 2026-10-23T18:00:00+03:00`);
    }
  }
  const ship = x.ship_by.value && Date.parse(x.ship_by.value);
  const deliver = x.deliver_by.value && Date.parse(x.deliver_by.value);
  if (ship && deliver && ship > deliver) problems.push("ship_by is after deliver_by");

  return problems.length ? { ok: false, problems } : { ok: true, value: x };
}

// Text that tries to instruct an AI. The chat is data: such messages are only flagged, never
// obeyed (rule 5). This list backs up the model's own instruction_flags.
const INSTRUCTION_LIKE = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier|these)\b/i,
  /\b(?:system|developer)\s*(?:prompt|message|instruction)s?\b/i,
  /^\s*(?:system|assistant)\s*:/i,
  /\b(?:note|message|instruction)s? (?:to|for) (?:the )?(?:ai|assistant|bot|model|system)\b/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|language model|chatbot)\b/i,
  /\b(?:ai|assistant|bot|model)\b[^.!?\n]{0,40}\b(?:set|change|make|output|write|use)\b[^.!?\n]{0,40}\b(?:price|amount|payee|email|paypal)\b/i,
];

export function instructionLikeMessages(messages: ChatMessage[]): string[] {
  return messages.filter((m) => INSTRUCTION_LIKE.some((r) => r.test(m.text))).map((m) => m.id);
}
