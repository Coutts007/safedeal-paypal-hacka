import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setExtractModel } from "@/lib/ai/service";
import { closeDb, getDb } from "@/lib/db";
import { aiExtractions, aiRuns, chatSources, dealTerms } from "@/lib/db/schema";
import { CHAT, extraction, fakeModel } from "@/tests/ai";
import { resetDb } from "@/tests/db";
import { POST as createDealRoute } from "./deals/route";
import { GET as getDealRoute } from "./deals/[ref]/route";
import { POST as termsRoute } from "./deals/[ref]/terms/route";
import { POST as extractRoute } from "./extract/route";

// Phase 4 end to end: paste a chat → AI proposal → seller creates the deal → Deal Room shows
// which chat message each field came from. The model is a fake; Anthropic is never called.

const db = getDb();
beforeEach(() => resetDb(db));
afterEach(() => setExtractModel(undefined));
afterAll(closeDb);

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": crypto.randomUUID(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
const ctx = (ref: string) => ({ params: Promise.resolve({ ref }) });

// Far-future dates, so the "date has passed" checks never depend on when the tests run.
const FUTURE_SHIP = "2030-11-03T18:00:00+03:00";
const answer = () =>
  extraction({ ship_by: { value: FUTURE_SHIP, sources: ["m4"], confidence: "medium" } });

async function readChat() {
  setExtractModel(fakeModel([answer()]).call);
  const res = await extractRoute(req({ chat: CHAT }));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    extractionId: string;
    status: string;
    proposal: { terms: Record<string, unknown> & { conditions: string[] } };
  };
}

describe("POST /api/extract", () => {
  it("answers 503 when no LLM key is configured, so the seller fills in by hand", async () => {
    const res = await extractRoute(req({ chat: CHAT }));
    expect(res.status).toBe(503);
  });

  it("stores the redacted chat and the proposal, and logs the call without content", async () => {
    const body = await readChat();
    expect(body.status).toBe("ok");
    expect(body.proposal.terms).toMatchObject({ item: "Samsung Galaxy A15", carrier: "G4S" });
    const [row] = await db
      .select()
      .from(aiExtractions)
      .where(eq(aiExtractions.id, body.extractionId));
    expect(row.redactedText).toContain("[PHONE_1]");
    expect(row.redactedText).not.toContain("0712");
    const runs = await db.select().from(aiRuns);
    expect(runs).toEqual([
      expect.objectContaining({ outcome: "ok", inputTokens: 100, outputTokens: 50, attempt: 1 }),
    ]);
  });

  it("rejects an over-long chat", async () => {
    const res = await extractRoute(req({ chat: "x".repeat(15_001) }));
    expect(res.status).toBe(400);
  });
});

describe("deal from a chat", () => {
  async function create(extractionId: string, terms: Record<string, unknown>) {
    return createDealRoute(req({ sellerName: "David", buyerName: "Shemaya", extractionId, terms }));
  }

  it("keeps the chat with the deal and shows each field's source in the Deal Room", async () => {
    const { extractionId, proposal } = await readChat();
    const terms = { ...proposal.terms, payeeEmail: "seller-a@example.com" };
    const res = await create(extractionId, terms);
    expect(res.status).toBe(201);
    const { ref, links } = (await res.json()) as {
      ref: string;
      links: { buyer: string; seller: string };
    };
    const token = (l: string) => new URL(l).searchParams.get("t") as string;

    const [stored] = await db.select().from(dealTerms);
    expect(stored.proposedBy).toBe("ai");
    expect(await db.select().from(chatSources)).toHaveLength(1);

    const view = (await (
      await getDealRoute(
        new Request("http://localhost/x", { headers: { "x-deal-token": token(links.buyer) } }),
        ctx(ref),
      )
    ).json()) as {
      chat: { id: string; text: string }[];
      sources: { fields: Record<string, { sources: string[]; edited: boolean }> };
      terms: { shipBy: string };
    };
    expect(view.chat[0]).toMatchObject({ id: "m1", text: expect.stringContaining("[PHONE_1]") });
    expect(view.sources.fields.item).toMatchObject({ sources: ["m2"], edited: false });
    expect(view.terms.shipBy).toBe(FUTURE_SHIP);

    // The buyer changes the item: it stops citing the chat; the carrier still does.
    const edit = await termsRoute(
      req(
        { terms: { ...terms, item: "Samsung Galaxy A15 128GB" } },
        { "x-deal-token": token(links.buyer) },
      ),
      ctx(ref),
    );
    expect(edit.status).toBe(200);
    const versions = await db.select().from(dealTerms).orderBy(dealTerms.version);
    expect(versions[1].sourceRefsJson).toMatchObject({
      fields: { item: { edited: true, sources: [] }, carrier: { edited: false, sources: ["m4"] } },
    });

    // A chat reading can only be used once.
    expect((await create(extractionId, terms)).status).toBe(400);
  });

  it("refuses dates that have already passed", async () => {
    const { extractionId, proposal } = await readChat();
    const res = await create(extractionId, {
      ...proposal.terms,
      payeeEmail: "seller-a@example.com",
      shipBy: "2020-01-01T18:00:00+03:00",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The ship-by date has passed" });
  });
});
