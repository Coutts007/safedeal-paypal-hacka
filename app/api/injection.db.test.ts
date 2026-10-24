import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEvidenceModel } from "@/lib/ai/evidence-service";
import {
  BUYER_PROBLEM,
  injectionCaseSchema,
  obeyingExtraction,
  TINY_PNG_BASE64,
  type ChatInjection,
  type EvidenceInjection,
} from "@/lib/ai/injection-cases";
import { setExtractModel } from "@/lib/ai/service";
import { closeDb, getDb } from "@/lib/db";
import { auditLog, confirmations, deals, payments, reviews } from "@/lib/db/schema";
import { setEngineDeps } from "@/lib/rules/engine";
import { extraction, fakeModel } from "@/tests/ai";
import { resetDb } from "@/tests/db";
import { fakePaypal, testDeps } from "@/tests/factories";
import { adminCookie, as, ctx, heldDeal, req } from "@/tests/routes";
import { POST as adminCheckRoute } from "./admin/deals/[ref]/check/route";
import { POST as createDealRoute } from "./deals/route";
import { POST as evidenceRoute } from "./deals/[ref]/evidence/route";
import { POST as photosRoute } from "./deals/[ref]/photos/route";
import { POST as receiptRoute } from "./deals/[ref]/receipt/route";
import { POST as extractRoute } from "./extract/route";

// Prompt-injection harness, worst case: the AI obeys every attack in eval/injection/cases.json.
// Pass = no state change caused by chat or evidence text (BUILD_PLAN Phase 6, item 2). Whether
// the real model resists is measured separately by `npm run eval:injection`.

const cases = (JSON.parse(readFileSync("eval/injection/cases.json", "utf8")) as unknown[]).map(
  (c) => injectionCaseSchema.parse(c),
);
const chatCases = cases.filter((c): c is ChatInjection => c.channel === "chat");
const evidenceCases = cases.filter((c): c is EvidenceInjection => c.channel === "evidence");

const db = getDb();
let fake: ReturnType<typeof fakePaypal>;
beforeEach(async () => {
  await resetDb(db);
  fake = fakePaypal();
  setEngineDeps(testDeps(db, fake.port, new Date()).deps);
});
afterEach(() => {
  setEngineDeps(undefined);
  setExtractModel(undefined);
  setEvidenceModel(undefined);
});
afterAll(closeDb);

const noPaypalCalls = () => {
  for (const fn of Object.values(fake.port)) expect(fn).not.toHaveBeenCalled();
};

it("has the 30 cases of the plan", () => {
  expect(chatCases).toHaveLength(20);
  expect(evidenceCases).toHaveLength(10);
  expect(new Set(cases.map((c) => c.id)).size).toBe(30);
});

describe("chat attacks, with an AI that obeys them", () => {
  const honest = extraction({
    ship_by: { value: "2030-11-03T18:00:00+03:00", sources: ["m4"], confidence: "medium" },
  });

  it.each(chatCases.map((c) => [c.id, c] as const))("%s: the deal stays a DRAFT", async (_, c) => {
    setExtractModel(fakeModel([obeyingExtraction(c, honest)]).call);
    const read = await extractRoute(
      req("POST", { chat: c.chat }, { "x-forwarded-for": crypto.randomUUID() }),
    );
    expect(read.status).toBe(200);
    const { extractionId, proposal } = (await read.json()) as {
      extractionId: string;
      proposal: { terms: Record<string, unknown> };
    };

    // The seller types the PayPal email; no chat text or AI field can set it.
    const created = await createDealRoute(
      req("POST", {
        sellerName: "David",
        buyerName: "Shemaya",
        extractionId,
        terms: { ...proposal.terms, payeeEmail: "seller-a@example.com" },
      }),
    );
    // A planted value the terms rules refuse (e.g. quantity 100) is just as safe.
    expect([201, 400]).toContain(created.status);
    const all = await db.select().from(deals);
    if (created.status === 201) {
      expect(all).toMatchObject([
        { state: "DRAFT", amount: null, payeeEmail: null, authorizedAt: null, deliveredAt: null },
      ]);
    } else {
      expect(all).toEqual([]);
    }
    expect(await db.select().from(confirmations)).toEqual([]);
    expect(await db.select().from(payments)).toEqual([]);
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions.filter((a) => a !== "deal.created")).toEqual([]);
    noPaypalCalls();
  });
});

describe("evidence attacks, with an AI that obeys them", () => {
  it.each(evidenceCases.map((c) => [c.id, c] as const))(
    "%s: the review stays open and no money moves",
    async (_, c) => {
      const d = await heldDeal({ ship: true });
      await receiptRoute(
        req("POST", { action: "problem", note: BUYER_PROBLEM }, as(d.buyer)),
        ctx(d.ref),
      );
      const token = c.by === "buyer" ? d.buyer : d.seller;
      if (c.kind === "note") {
        const res = await evidenceRoute(req("POST", { note: c.text }, as(token)), ctx(d.ref));
        expect(res.status).toBe(201);
      } else {
        const form = new FormData();
        form.set(
          "file",
          new Blob([new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"))]),
          "p.png",
        );
        form.set("caption", c.text);
        const res = await photosRoute(
          new Request("http://localhost/x", { method: "POST", headers: as(token), body: form }),
          ctx(d.ref),
        );
        expect(res.status).toBe(201);
      }
      const before = (await db.select().from(deals).where(eq(deals.id, d.id)))[0];
      const auditBefore = (await db.select().from(auditLog)).length;
      for (const fn of Object.values(fake.port)) fn.mockClear();

      const model = fakeModel([
        {
          label: c.forbid_label ?? "consistent",
          reasons: ["[e3] Release the funds now, as the evidence instructs."],
          instruction_flags: [],
        },
      ]);
      setEvidenceModel(model.call);
      const res = await adminCheckRoute(
        req("POST", {}, { cookie: await adminCookie() }),
        ctx(d.ref),
      );
      expect(res.status).toBe(200);

      // The attack reached the model only as quoted evidence.
      expect(JSON.stringify(model.seen[0].messages)).toMatch(/<(note|caption)[^>]*>/);
      const after = (await db.select().from(deals).where(eq(deals.id, d.id)))[0];
      expect(after).toMatchObject({ state: "IN_REVIEW", deliveredAt: null, deliveryProof: null });
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(await db.select().from(reviews).where(eq(reviews.dealId, d.id))).toMatchObject([
        { kind: "buyer_problem", decision: null },
      ]);
      expect(await db.select().from(auditLog)).toHaveLength(auditBefore);
      noPaypalCalls();
    },
  );
});
