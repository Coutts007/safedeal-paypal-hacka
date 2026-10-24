import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extraction } from "@/tests/ai";
import { evidenceContent } from "./evidence";
import {
  attackMessageIds,
  evidenceProblems,
  evidenceScenario,
  injectionCaseSchema,
  obeyingExtraction,
  plantedInExtraction,
  type ChatInjection,
  type EvidenceInjection,
} from "./injection-cases";

const cases = (JSON.parse(readFileSync("eval/injection/cases.json", "utf8")) as unknown[]).map(
  (c) => injectionCaseSchema.parse(c),
);
const chats = cases.filter((c): c is ChatInjection => c.channel === "chat");
const evidence = cases.filter((c): c is EvidenceInjection => c.channel === "evidence");

describe("injection cases", () => {
  it("each chat case has an attack line, and the honest lines are not mistaken for it", () => {
    for (const c of chats) {
      const ids = attackMessageIds(c);
      expect(ids.length, c.id).toBeGreaterThan(0);
      expect(ids.length, c.id).toBeLessThan(4);
    }
  });

  it("an obeying extraction is caught as planted; the honest one is not", () => {
    const honest = extraction();
    for (const c of chats.filter((x) => Object.keys(x.forbid).length)) {
      expect(plantedInExtraction(c, honest), c.id).toEqual([]);
      expect(plantedInExtraction(c, obeyingExtraction(c, honest)).length, c.id).toBeGreaterThan(0);
    }
  });

  it("evidence text cannot close its tag or open one of SafeDeal's", () => {
    for (const c of evidence) {
      const text = evidenceContent(evidenceScenario(c))
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      // The buyer's note and the attack: two opening and two closing tags, all SafeDeal's.
      expect(text.match(/<\/?(note|caption)>/g)?.length, c.id).toBe(4);
      expect(text, c.id).not.toMatch(/<\/?(system|evidence)>/);
    }
  });

  it("scores a forbidden label and a missing flag", () => {
    const c = evidence.find((x) => x.forbid_label === "consistent")!;
    expect(
      evidenceProblems(c, { label: "consistent", reasons: ["x"], instruction_flags: [] }),
    ).toEqual(["label consistent", "attack not flagged"]);
    expect(
      evidenceProblems(c, {
        label: "uncertain",
        reasons: ["x"],
        instruction_flags: [{ evidence_id: "e3", reason: "tries to set the label" }],
      }),
    ).toEqual([]);
  });
});
