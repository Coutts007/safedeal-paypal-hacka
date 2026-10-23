import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// RULE 1: only lib/rules/engine.ts may call capture, void or refund. This scans the source tree:
// - only the engine (and tests) may import lib/paypal/payments;
// - only payments.ts may contain the capture/void/refund endpoint paths.
// The Phase 1 spike files are the logged exception (DECISIONS 2026-10-20): never imported by the
// app, and their routes answer 404 in production.

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "drizzle",
  "docs",
  "coverage",
  "playwright-report",
  "test-results",
]);
const SPIKE = new Set(["scripts/spike.ts"]);

function sourceFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : sourceFiles(join(dir, e.name));
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [relative(ROOT, join(dir, e.name))] : [];
  });
}

const isTest = (f: string) => /\.test\.ts$/.test(f) || f.startsWith("tests/");
const files = sourceFiles().filter((f) => !isTest(f));

describe("rule 1: only the rule engine moves money", () => {
  it("found the source tree", () => {
    expect(files).toContain("lib/rules/engine.ts");
    expect(files).toContain("lib/paypal/payments.ts");
  });

  it("only lib/rules/engine.ts imports lib/paypal/payments", () => {
    const importers = files.filter((f) =>
      /from\s+["'](?:@\/lib\/paypal|\.{1,2}(?:\/[\w.-]+)*)\/payments["']/.test(
        readFileSync(join(ROOT, f), "utf8"),
      ),
    );
    expect(importers).toEqual(["lib/rules/engine.ts"]);
  });

  it("no other file builds a capture, void or refund URL", () => {
    const pattern =
      /\/(capture|void|refund)\b["'`]|authorizations\/[^"'`]*\/(capture|void)|captures\/[^"'`]*\/refund/;
    const offenders = files.filter(
      (f) =>
        f !== "lib/paypal/payments.ts" &&
        !SPIKE.has(f) &&
        pattern.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("AI code cannot reach the engine or PayPal, and the engine never reads AI evidence labels", () => {
    const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
    const aiFiles = files.filter((f) => f.startsWith("lib/ai/"));
    expect(aiFiles.length).toBeGreaterThan(5);
    const aiImportingEngine = aiFiles.filter((f) =>
      /from\s+["']@\/lib\/(rules|paypal)\//.test(read(f)),
    );
    expect(aiImportingEngine).toEqual([]);

    const ruleFiles = files.filter((f) => f.startsWith("lib/rules/"));
    for (const f of ruleFiles) {
      const src = read(f);
      // Only the pure source-reference helper may be imported from lib/ai (no model, no labels).
      const aiImports = [...src.matchAll(/from\s+["']@\/lib\/ai\/([\w-]+)["']/g)].map((m) => m[1]);
      expect(aiImports.filter((m) => m !== "proposal")).toEqual([]);
      expect(src).not.toMatch(/evidenceChecks|evidence_checks|checkLabel|check_label/);
    }
  });
});
