import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeSingleActorFlow,
  RuntimeFailure,
  FlowFailure,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import {
  capabilities,
  type Capability,
  type CompiledStep,
} from "@polymux/protocol";
import { compileSingleActorFlow } from "@polymux/core";

class FakeDriver implements Driver {
  readonly id = "fake.web";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.navigate,
    capabilities.expect,
  ]);

  constructor(private readonly fail = false) {}

  async createSession(_context: DriverSessionContext): Promise<DriverSession> {
    const fail = this.fail;
    return {
      async execute(step: CompiledStep) {
        if (fail && step.kind === "expect") {
          throw new FlowFailure("Expected confirmation");
        }
        return;
      },
      async close() {
        return [];
      },
    };
  }
}

describe("deterministic runtime", () => {
  it("executes steps and writes machine-readable and HTML reports", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-runtime-"));
    const plan = compileSingleActorFlow(
      {
        version: 1,
        name: "Smoke",
        steps: [
          { navigate: "https://example.com" },
          { expect: { text: "Example" } },
        ],
      },
      join(projectDir, "polymux/smoke.flow.yaml"),
    );
    const result = await executeSingleActorFlow(plan, new FakeDriver(), {
      projectDir,
    });

    expect(result.status).toBe("passed");
    expect(result.origin).toMatchObject({ kind: "local" });
    expect(result.steps.map((step) => step.status)).toEqual([
      "passed",
      "passed",
    ]);
    const json = JSON.parse(
      await readFile(join(result.artifactsDir, "results.json"), "utf8"),
    );
    expect(json.runId).toBe(result.runId);
    const html = await readFile(
      join(result.artifactsDir, "report.html"),
      "utf8",
    );
    expect(html).toContain("Smoke");
    expect(html).toContain("Passed");
    expect(html).toContain("local:");
  });

  it("records assertion failures without re-running through an agent", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-failure-"));
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Failure",
      steps: [
        { navigate: "https://example.com" },
        { expect: { text: "Missing" } },
      ],
    });
    const result = await executeSingleActorFlow(plan, new FakeDriver(true), {
      projectDir,
    });

    expect(result.status).toBe("failed");
    expect(result.steps[1]?.error).toMatchObject({
      category: "assertion",
      message: "Expected confirmation",
    });
  });

  it("fails before execution when a driver lacks a required capability", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-capability-"));
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Unsupported",
      steps: [{ multiTouch: { gesture: "pinch-in", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] } }],
    });

    await expect(
      executeSingleActorFlow(plan, new FakeDriver(), { projectDir }),
    ).rejects.toThrow(RuntimeFailure);
  });
});
