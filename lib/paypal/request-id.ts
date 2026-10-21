// Rule 3: every PayPal POST carries a fixed PayPal-Request-Id, `deal-<dealUuid>-<action>-v<n>`.
// `n` rises only when a new attempt is intended (e.g. the buyer pays again after FUNDING_FAILED).

export type PaypalAction = "create" | "authorize" | "capture" | "void" | "refund";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function paypalRequestId(dealId: string, action: PaypalAction, attempt: number): string {
  if (!UUID.test(dealId)) throw new Error("deal id must be a UUID");
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be 1 or more");
  return `deal-${dealId.toLowerCase()}-${action}-v${attempt}`;
}
