import { describe, expect, it } from "vitest";
import { paypalRequestId } from "./request-id";

const id = "0b6f1c1e-3c55-4a8e-9a0f-1d2b3c4d5e6f";

describe("paypalRequestId", () => {
  it("builds deal-<uuid>-<action>-v<n>", () => {
    expect(paypalRequestId(id, "capture", 1)).toBe(`deal-${id}-capture-v1`);
  });

  it("rejects a non-UUID deal id or a bad attempt", () => {
    expect(() => paypalRequestId("42", "capture", 1)).toThrow("UUID");
    expect(() => paypalRequestId(id, "capture", 0)).toThrow("attempt");
  });
});
