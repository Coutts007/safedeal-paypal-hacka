import { z } from "zod";
import { callPaypal, type PaypalResult } from "./result";

// Read-only for now; providing evidence (`provide-evidence`) is a stretch goal.

const disputeSchema = z.object({
  dispute_id: z.string(),
  status: z.string(),
  disputed_transactions: z
    .array(z.object({ seller_transaction_id: z.string().optional() }))
    .optional(),
});

export type Dispute = { id: string; status: string; captureIds: string[] };

export function getDispute(disputeId: string): Promise<PaypalResult<Dispute>> {
  return callPaypal(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}`,
    { record: { dealId: null, action: "get_dispute" } },
    (j) => {
      const d = disputeSchema.parse(j);
      return {
        id: d.dispute_id,
        status: d.status,
        captureIds: (d.disputed_transactions ?? []).flatMap((t) =>
          t.seller_transaction_id ? [t.seller_transaction_id] : [],
        ),
      };
    },
  );
}
