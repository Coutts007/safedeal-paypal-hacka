import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./hash";

describe("canonicalJson", () => {
  it("sorts keys at every level and ignores insertion order", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: "s" } };
    const b = { a: { c: "s", d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"s","d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("drops undefined members, keeps null, encodes dates as ISO", () => {
    expect(canonicalJson({ a: undefined, b: null, d: new Date(0) })).toBe(
      '{"b":null,"d":"1970-01-01T00:00:00.000Z"}',
    );
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of an empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
