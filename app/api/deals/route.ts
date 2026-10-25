import { z } from "zod";
import { accountFromRequest } from "@/lib/accounts/http";
import { getDb } from "@/lib/db";
import { createDeal, dealLinks } from "@/lib/deals/service";
import { serverEnv } from "@/lib/env";
import { describeError, fail, json, readJson } from "@/lib/http";

const body = z.object({
  sellerName: z.string().trim().min(1).max(60),
  buyerName: z.string().trim().min(1).max(60),
  terms: z.unknown(),
  extractionId: z.uuid().nullish(),
});

/**
 * Seller creates a deal, by hand or from a chat the AI read (`extractionId`). A logged-in seller
 * owns the deal, and it pays out to their verified PayPal email whatever the form sent.
 */
export async function POST(req: Request) {
  const input = await readJson(req, body);
  if (!input.ok) return input.response;
  const env = serverEnv();
  const account = await accountFromRequest(req);
  try {
    const deal = await createDeal(
      getDb(),
      { ...input.data, account },
      {
        maxUsd: env.MAX_DEAL_USD,
        kesPerUsd: env.KES_PER_USD,
        now: new Date(),
      },
    );
    return json({ ref: deal.publicRef, links: dealLinks(env.APP_BASE_URL, deal) }, 201);
  } catch (e) {
    return fail(400, describeError(e));
  }
}
