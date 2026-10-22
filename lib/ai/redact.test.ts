import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  it("replaces Kenyan phone numbers in every common format, one token per number", () => {
    const r = redact("Call 0712 345 678 or +254712345678 or 254-712-345-678. Office 0110 222 333");
    expect(r.text).toBe("Call [PHONE_1] or [PHONE_1] or [PHONE_1]. Office [PHONE_2]");
    expect(r.counts.PHONE).toBe(2);
  });

  it("replaces emails, M-PESA codes and card numbers", () => {
    const r = redact(
      "Pay to brian.k@example.com, ref SJK4H7PL2Q. Card 4111 1111 1111 1111 works. BRIAN.K@example.com",
    );
    expect(r.text).toBe("Pay to [EMAIL_1], ref [MPESA_1]. Card [CARD_1] works. [EMAIL_1]");
  });

  it("leaves prices, dates, times, sizes and model names alone", () => {
    const text =
      "[20/10/2026, 09:01] Achieng: 12,000 or 12000 bob? Samsung A15 128GB, size 42, kesho 14:30. Order 1234567890123 (no Luhn)";
    expect(redact(text).text).toBe(text);
  });

  it("does not treat an all-letter word as an M-PESA code", () => {
    expect(redact("CONFIRMED PLAYSTATION").text).toBe("CONFIRMED PLAYSTATION");
  });
});
