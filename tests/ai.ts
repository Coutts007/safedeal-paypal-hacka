import type { ModelCall, ModelReply } from "@/lib/ai/extract";
import type { Extraction } from "@/lib/ai/schema";

// Helpers for AI tests: a well-formed extraction, and a fake model that replays answers.

export function extraction(patch: Partial<Extraction> = {}): Extraction {
  return {
    item: { value: "Samsung Galaxy A15", sources: ["m2"], confidence: "high" },
    quantity: { value: 1, sources: ["m2"], confidence: "high" },
    price: { amount: "12350.00", currency: "KES", sources: ["m3"], confidence: "high" },
    delivery_method: { value: "courier", sources: ["m4"], confidence: "high" },
    carrier: { value: "G4S", sources: ["m4"], confidence: "high" },
    ship_by: { value: "2026-11-03T18:00:00+03:00", sources: ["m4"], confidence: "medium" },
    deliver_by: { value: null, sources: [], confidence: "low" },
    conditions: [{ text: "Screen has no cracks", sources: ["m3"] }],
    language_mix: "english",
    missing_fields: ["deliver_by"],
    instruction_flags: [],
    notes_for_humans: "",
    ...patch,
  };
}

export const CHAT = [
  "[02/11/2026, 09:01] Shemaya: Is the A15 still available? Call me on 0712 345 678",
  "[02/11/2026, 09:03] David: Yes, Samsung Galaxy A15, 128GB",
  "[02/11/2026, 09:05] David: 12,350 bob. Screen has no cracks",
  "[02/11/2026, 09:06] David: I send by G4S kesho",
].join("\n");

/** Replays the given answers in order; each is JSON text, an Error, or "refusal". */
export function fakeModel(answers: (unknown | Error | "refusal")[]) {
  const seen: Parameters<ModelCall>[0][] = [];
  const call: ModelCall = async (req) => {
    seen.push(structuredClone(req));
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const text = next === "refusal" ? "" : JSON.stringify(next);
    const reply: ModelReply = {
      content: [{ type: "text", text, citations: null }],
      text,
      stopReason: next === "refusal" ? "refusal" : "end_turn",
      model: "fake-model",
      inputTokens: 100,
      outputTokens: 50,
    };
    return reply;
  };
  return { call, seen };
}
