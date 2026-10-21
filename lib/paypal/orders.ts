import { z } from "zod";
import { callPaypal, type PaypalResult } from "./result";

// Orders v2. Amount, currency and payee always come from the deal row built from confirmed terms
// (rule 2); callers never pass browser input here.

export type OrderSource = {
  dealId: string;
  publicRef: string;
  /** numeric(10,2) string from the database, e.g. "95.00". */
  amount: string;
  currency: "USD";
  payeeEmail: string;
  /** Item name from the confirmed terms; cut to PayPal's 127-character limit. */
  description: string;
};

export function buildOrderBody(src: OrderSource) {
  if (!/^\d{1,8}\.\d{2}$/.test(src.amount)) throw new Error("amount must be a 2-decimal string");
  return {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: src.publicRef,
        custom_id: src.dealId,
        description: src.description.slice(0, 127),
        amount: { currency_code: src.currency, value: src.amount },
        payee: { email_address: src.payeeEmail },
      },
    ],
  };
}

const authorizationSchema = z.object({
  id: z.string(),
  status: z.string(),
  expiration_time: z.string().optional(),
});

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z
    .array(
      z.object({
        custom_id: z.string().optional(),
        amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
        payee: z.object({ email_address: z.string().optional() }).optional(),
        payments: z.object({ authorizations: z.array(authorizationSchema).optional() }).optional(),
      }),
    )
    .optional(),
});

export type PaypalOrder = z.infer<typeof orderSchema>;
export type Authorization = { id: string; status: string; expiresAt: Date | null };

export function createOrder(
  src: OrderSource,
  requestId: string,
): Promise<PaypalResult<PaypalOrder>> {
  return callPaypal(
    "/v2/checkout/orders",
    {
      method: "POST",
      body: buildOrderBody(src),
      requestId,
      record: { dealId: src.dealId, action: "create" },
    },
    (j) => orderSchema.parse(j),
  );
}

export function getOrder(
  orderId: string,
  dealId: string | null,
): Promise<PaypalResult<PaypalOrder>> {
  return callPaypal(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    { record: { dealId, action: "get_order" } },
    (j) => orderSchema.parse(j),
  );
}

/** Authorise an approved order; returns the first authorization (id, status, expiry). */
export function authorizeOrder(
  orderId: string,
  requestId: string,
  dealId: string,
): Promise<PaypalResult<Authorization>> {
  return callPaypal(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    { method: "POST", body: {}, requestId, record: { dealId, action: "authorize" } },
    (j) => {
      const auth = orderSchema.parse(j).purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth) throw new Error("no authorization in the response");
      return {
        id: auth.id,
        status: auth.status,
        expiresAt: auth.expiration_time ? new Date(auth.expiration_time) : null,
      };
    },
  );
}
