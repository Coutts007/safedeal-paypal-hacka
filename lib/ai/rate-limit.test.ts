import { describe, expect, it } from "vitest";
import { slidingWindow } from "./rate-limit";

describe("slidingWindow", () => {
  it("allows the limit per key, then refuses until the window moves on", () => {
    const l = slidingWindow(2, 1000);
    expect([l.take("a", 0), l.take("a", 10), l.take("a", 20)]).toEqual([true, true, false]);
    expect(l.take("b", 20)).toBe(true);
    expect(l.take("a", 1001)).toBe(true);
  });
});
