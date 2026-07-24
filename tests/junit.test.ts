import { describe, expect, it } from "vitest";
import type { RunResult } from "@polymux/protocol";
import { effectiveRunStatus } from "@polymux/runner";
import { renderJUnit } from "../apps/cli/src/junit.js";

function result(
  status: RunResult["status"],
  knownFailure?: RunResult["knownFailure"],
): RunResult {
  return {
    formatVersion: 1,
    runId: "run-1",
    flow: "Checkout",
    flowHash: "abc123",
    sourcePath: "/project/polymux/checkout.flow.yaml",
    tags: ["smoke", "checkout"],
    ...(knownFailure ? { knownFailure } : {}),
    platform: "web",
    status,
    startedAt: "2026-07-23T00:00:00.000Z",
    finishedAt: "2026-07-23T00:00:01.000Z",
    durationMs: 1000,
    artifactsDir: "/project/.polymux/runs/run-1",
    artifacts: [],
    steps: status === "passed"
      ? []
      : [{
          id: "001-expect",
          kind: "expect",
          status,
          startedAt: "2026-07-23T00:00:00.000Z",
          finishedAt: "2026-07-23T00:00:01.000Z",
          durationMs: 1000,
          artifacts: [],
          error: {
            name: "FlowFailure",
            message: "Expected confirmation",
            category: status === "failed" ? "assertion" : "runtime",
          },
        }],
  };
}

describe("JUnit reporting", () => {
  it("reports expected known failures as visible non-blocking cases", () => {
    const run = result("failed", {
      reason: "Confirmed regression",
      expires: "2999-01-01",
      outcome: "expected-failure",
    });
    expect(effectiveRunStatus(run)).toBe("passed");
    const xml = renderJUnit([run]);
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain("Known failure: Confirmed regression");
    expect(xml).toContain("tags: smoke, checkout");
  });

  it("fails unexpected passes so stale markers are removed", () => {
    const run = result("passed", {
      reason: "Confirmed regression",
      expires: "2999-01-01",
      outcome: "unexpected-pass",
    });
    expect(effectiveRunStatus(run)).toBe("failed");
    const xml = renderJUnit([run]);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('type="unexpected-pass"');
  });
});
