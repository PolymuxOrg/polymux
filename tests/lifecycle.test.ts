import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileSingleActorFlow,
  compileSingleActorFlowFile,
  executeSingleActorFlow,
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

class LifecycleDriver implements Driver {
  readonly id = "lifecycle.web";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.navigate,
    capabilities.expect,
  ]);
  readonly executed: string[] = [];

  async createSession(_context: DriverSessionContext): Promise<DriverSession> {
    return {
      execute: async (step: CompiledStep) => {
        this.executed.push(String(step.input.to ?? step.kind));
        if (step.kind === "expect") throw new FlowFailure("Main flow failed");
      },
      close: async () => [],
    };
  }
}

describe("flow lifecycle", () => {
  it("compiles relative subflows and rejects reference cycles", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-subflow-"));
    const child = join(projectDir, "shared.flow.yaml");
    const parent = join(projectDir, "parent.flow.yaml");
    await writeFile(
      child,
      "version: 1\nname: Shared\nsteps:\n  - navigate: /shared\n",
    );
    await writeFile(
      parent,
      "version: 1\nname: Parent\nsetup:\n  - flow: shared.flow.yaml\nsteps:\n  - navigate: /main\nteardown:\n  - navigate: /cleanup\n",
    );

    const plan = await compileSingleActorFlowFile(parent);
    expect(plan.setup[0]).toMatchObject({
      kind: "flow",
      flow: { name: "Shared" },
    });
    expect(plan.requiredCapabilities).toEqual(["navigation.navigate"]);

    await writeFile(
      child,
      "version: 1\nname: Shared\nsteps:\n  - flow: parent.flow.yaml\n",
    );
    await expect(compileSingleActorFlowFile(parent)).rejects.toThrow(
      "Circular flow reference",
    );
  });

  it("runs teardown after a main failure without replacing that failure", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-lifecycle-"));
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Lifecycle",
      setup: [{ navigate: "/setup" }],
      steps: [{ expect: { text: "Missing" } }],
      teardown: [{ navigate: "/cleanup" }],
    });
    const driver = new LifecycleDriver();

    const result = await executeSingleActorFlow(plan, driver, { projectDir });

    expect(result.status).toBe("failed");
    expect(driver.executed).toEqual(["/setup", "expect", "/cleanup"]);
    expect(result.steps.map((step) => step.phase)).toEqual([
      "setup",
      "steps",
      "teardown",
    ]);
  });
});
