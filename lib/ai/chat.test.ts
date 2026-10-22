import { describe, expect, it } from "vitest";
import { chatStartDate, formatForModel, parseChat } from "./chat";

describe("parseChat", () => {
  it("numbers WhatsApp iOS and Android lines and joins continuation lines", () => {
    const msgs = parseChat(
      "[20/10/2026, 09:01] Achieng: Hi\nstill there?\n20/10/2026, 09:03 - Brian: Yes, 12k",
    );
    expect(msgs).toEqual([
      { id: "m1", at: "2026-10-20T09:01", from: "Achieng", text: "Hi\nstill there?" },
      { id: "m2", at: "2026-10-20T09:03", from: "Brian", text: "Yes, 12k" },
    ]);
    expect(chatStartDate(msgs)).toBe("2026-10-20");
    expect(formatForModel(msgs)).toBe(
      "[m1] (2026-10-20 09:01) Achieng: Hi\nstill there?\n[m2] (2026-10-20 09:03) Brian: Yes, 12k",
    );
  });

  it("treats each line of plain text as a message", () => {
    expect(parseChat("Hi\n\n  12k ok?  ")).toEqual([
      { id: "m1", at: null, from: null, text: "Hi" },
      { id: "m2", at: null, from: null, text: "12k ok?" },
    ]);
  });
});
