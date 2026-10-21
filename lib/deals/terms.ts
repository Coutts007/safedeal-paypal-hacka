import { z } from "zod";
import { canonicalJson, sha256Hex } from "@/lib/hash";

// The deal terms both parties confirm. The AI only proposes these; whatever is stored here (and
// hashed) is what PayPal is asked to charge and pay out (rule 2).

const usdAmount = z
  .string()
  .regex(/^\d{1,8}\.\d{2}$/, "amount must look like 95.00")
  .refine((v) => Number(v) > 0, "amount must be above zero");

export const dealTermsSchema = z.object({
  item: z.string().trim().min(1).max(127),
  quantity: z.number().int().min(1).max(1000),
  price: z.object({ amount: usdAmount, currency: z.literal("USD") }),
  deliveryMethod: z.enum(["courier", "rider", "pickup", "post", "other"]),
  carrier: z.string().trim().min(1).max(80).nullable(),
  shipBy: z.iso.datetime({ offset: true }).nullable(),
  deliverBy: z.iso.datetime({ offset: true }).nullable(),
  inspectionHours: z.number().int().min(1).max(168).default(48),
  conditions: z.array(z.string().trim().min(1).max(280)).max(20).default([]),
  payeeEmail: z.email().max(254),
});

export type DealTerms = z.infer<typeof dealTermsSchema>;

/** Parse and apply the per-deal cap (US$500 in the sandbox by default). */
export function parseDealTerms(input: unknown, maxUsd: number): DealTerms {
  const terms = dealTermsSchema.parse(input);
  if (Number(terms.price.amount) > maxUsd) {
    throw new Error(`Deal amount ${terms.price.amount} USD is above the ${maxUsd} USD cap`);
  }
  return { ...terms, payeeEmail: terms.payeeEmail.toLowerCase() };
}

/** Both confirmations must carry this hash for the deal to become AGREED. */
export function termsHash(terms: DealTerms): string {
  return sha256Hex(canonicalJson(terms));
}
