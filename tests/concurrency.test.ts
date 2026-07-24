import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileCoordinatedFlowFile,
  discoverFlows,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
  FlowFailure,
} from "@polymux/core";
import { capabilities, type Capability, type CompiledStep } from "@polymux/protocol";
import { runCoordinatedFlowInstances, runSingleActorFlowFiles, schedule } from "@polymux/runner";

class ConcurrentFakeDriver implements Driver {
  readonly id = "fake.concurrent";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.navigate,
    capabilities.expect,
    capabilities.wait,
  ]);
  active = 0;
  maxActive = 0;

  async createSession(_context: DriverSessionContext): Promise<DriverSession> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return {
      execute: async (_step: CompiledStep) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      },
      close: async () => {
        this.active -= 1;
        return [];
      },
    };
  }
}

class FailingActorDriver extends ConcurrentFakeDriver {
  override async createSession(context: DriverSessionContext): Promise<DriverSession> {
    const session = await super.createSession(context);
    return {
      execute: async (step) => {
        if (step.kind === "expect") throw new FlowFailure("Actor assertion failed");
        return session.execute(step);
      },
      close: () => session.close(),
    };
  }
}

describe("bounded execution scheduler", () => {
  it("honours its concurrency bound and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await schedule([3, 1, 2, 0], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, value * 5));
      active -= 1;
      return value * 2;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual([6, 2, 4, 0]);
  });

  it("runs repeated flows concurrently with isolated run artifacts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-concurrency-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    const flow = join(flowDir, "smoke.flow.yaml");
    await writeFile(flow, [
      "version: 1",
      "name: Concurrent smoke",
      "steps:",
      "  - navigate: https://example.com",
      "  - wait: 1",
      "",
    ].join("\n"));
    const driver = new ConcurrentFakeDriver();
    const result = await runSingleActorFlowFiles([flow], driver, {
      projectDir,
      repeat: 4,
      concurrency: 2,
    });

    expect(result.status).toBe("passed");
    expect(result.runs.map((run) => run.instance)).toEqual([1, 2, 3, 4]);
    expect(new Set(result.runs.map((run) => run.runId)).size).toBe(4);
    expect(driver.maxActive).toBe(2);
  });
});

describe("multi-actor flows", () => {
  it("coordinates isolated actors through durable signals", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-flow-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    await writeFile(join(flowDir, "buyer.flow.yaml"), [
      "version: 1",
      "name: Buyer",
      "steps:",
      "  - navigate: https://example.com/buy",
      "  - signal: order-created",
      "  - waitForSignal: order-approved",
      "  - expect:",
      "      text: Approved",
      "",
    ].join("\n"));
    await writeFile(join(flowDir, "seller.flow.yaml"), [
      "version: 1",
      "name: Seller",
      "steps:",
      "  - waitForSignal: order-created",
      "  - navigate: https://example.com/orders",
      "  - signal: order-approved",
      "",
    ].join("\n"));
    const flowPath = join(flowDir, "purchase.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Purchase approval",
      "actors:",
      "  buyer: buyer.flow.yaml",
      "  seller:",
      "    flow: seller.flow.yaml",
      "",
    ].join("\n"));

    expect(await discoverFlows(projectDir)).toEqual([
      flowPath,
    ]);
    expect(await discoverFlows(projectDir, "buyer")).toEqual([
      join(flowDir, "buyer.flow.yaml"),
    ]);
    const flow = await compileCoordinatedFlowFile(flowPath);
    const result = await runCoordinatedFlowInstances(flow, new ConcurrentFakeDriver(), {
      projectDir,
      instances: 2,
      concurrency: 2,
    });

    expect(result.status).toBe("passed");
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]?.actors.map(({ actor }) => actor)).toEqual(["buyer", "seller"]);
    expect(result.runs[0]?.actors.flatMap(({ run }) => run.steps.map((step) => step.message)))
      .toEqual(expect.arrayContaining(["Signalled order-created", "Received order-approved", "Received order-created", "Signalled order-approved"]));
    const report = await readFile(join(result.runs[0]!.artifactsDir, "report.html"), "utf8");
    expect(report).toContain("Purchase approval");
    expect(report).toContain("buyer");
  });

  it("unblocks dependent actors when another actor fails", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-flow-failure-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    await writeFile(join(flowDir, "leader.flow.yaml"), [
      "version: 1",
      "name: Leader",
      "steps:",
      "  - expect:",
      "      text: Never present",
      "  - signal: ready",
      "",
    ].join("\n"));
    await writeFile(join(flowDir, "follower.flow.yaml"), [
      "version: 1",
      "name: Follower",
      "steps:",
      "  - waitForSignal:",
      "      name: ready",
      "      timeoutMs: 1000",
      "",
    ].join("\n"));
    const flowPath = join(flowDir, "failure.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Failure propagation",
      "actors:",
      "  leader: leader.flow.yaml",
      "  follower: follower.flow.yaml",
      "",
    ].join("\n"));

    const started = Date.now();
    const result = await runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(flowPath),
      new FailingActorDriver(),
      { projectDir },
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.status).toBe("error");
    expect(result.runs[0]?.actors.map(({ run }) => run.status)).toEqual(["failed", "error"]);
    expect(result.runs[0]?.actors[1]?.run.steps[0]?.error?.message).toContain('Actor "leader" failed');
  });
});

describe("directory collections", () => {
  it("uses nested directories as zero-config flow collections", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-directory-collection-"));
    const smokeDir = join(projectDir, "polymux/smoke");
    await mkdir(smokeDir, { recursive: true });
    await writeFile(join(smokeDir, "checkout.flow.yaml"), "version: 1\nname: Checkout\nsteps:\n  - wait: 1\n");
    await writeFile(join(smokeDir, "buyer.flow.yaml"), "version: 1\nname: Buyer\nsteps:\n  - wait: 1\n");
    await writeFile(join(smokeDir, "purchase.flow.yaml"), "version: 1\nname: Purchase\nactors:\n  buyer: buyer.flow.yaml\n");

    const expected = [
      join(smokeDir, "checkout.flow.yaml"),
      join(smokeDir, "purchase.flow.yaml"),
    ];
    expect(await discoverFlows(projectDir, "smoke")).toEqual(expected);
    expect(await discoverFlows(projectDir, "polymux/smoke")).toEqual(expected);
  });

  it("reports a flow and directory with the same selector as ambiguous", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-directory-ambiguous-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(join(flowDir, "smoke"), { recursive: true });
    await writeFile(join(flowDir, "smoke.flow.yaml"), "version: 1\nname: Smoke\nsteps:\n  - wait: 1\n");
    await writeFile(join(flowDir, "smoke/login.flow.yaml"), "version: 1\nname: Login\nsteps:\n  - wait: 1\n");

    await expect(discoverFlows(projectDir, "smoke")).rejects.toThrow(
      "ambiguous between a flow and a directory collection",
    );
  });

});
