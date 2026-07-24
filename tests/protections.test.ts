import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileCoordinatedFlowFile,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import {
  capabilities,
  type Capability,
  type CompiledStep,
  type RunEvent,
} from "@polymux/protocol";
import { runCoordinatedFlowInstances } from "@polymux/runner";

class ProtectionDriver implements Driver {
  readonly id = "protection.web";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([capabilities.navigate]);
  readonly supportsScopedHeaders = true;
  readonly sessions: DriverSessionContext[] = [];
  readonly steps: CompiledStep[] = [];

  async createSession(context: DriverSessionContext): Promise<DriverSession> {
    this.sessions.push(context);
    return {
      execute: async (step) => {
        this.steps.push(step);
      },
      close: async () => [],
    };
  }
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function writeProtectedFlow(protection: string): Promise<{
  projectDir: string;
  flowPath: string;
}> {
  const projectDir = await mkdtemp(join(tmpdir(), "polymux-static-protection-"));
  const directory = join(projectDir, "polymux");
  await mkdir(directory);
  for (const actor of ["buyer", "seller"]) {
    await writeFile(join(directory, `${actor}.flow.yaml`), [
      "version: 1",
      `name: ${actor}`,
      "steps:",
      `  - navigate: \${protections.access.values.origin}/${actor}`,
      "",
    ].join("\n"));
  }
  const flowPath = join(directory, "protected.flow.yaml");
  await writeFile(flowPath, [
    "version: 1",
    "name: Static test access",
    "protections:",
    ...protection.split("\n").map((line) => `  ${line}`),
    "actors:",
    "  buyer: buyer.flow.yaml",
    "  seller: seller.flow.yaml",
    "",
  ].join("\n"));
  return { projectDir, flowPath };
}

describe("static flow protections", () => {
  it("loads exact-origin headers from the environment for every actor", async () => {
    const { projectDir, flowPath } = await writeProtectedFlow([
      "access:",
      "  originFromEnv: TEST_PROTECTION_ORIGIN",
      "  headersFromEnv:",
      "    x-polymux-test-access: TEST_PROTECTION_TOKEN",
    ].join("\n"));
    await withEnvironment({
      POLYMUX_TEST_ENVIRONMENT: "test",
      TEST_PROTECTION_ORIGIN: "https://staging.example.test",
      TEST_PROTECTION_TOKEN: "static-protection-secret",
    }, async () => {
      const driver = new ProtectionDriver();
      const events: RunEvent[] = [];
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir, onEvent: (event) => events.push(event) },
      );

      expect(batch.status).toBe("passed");
      expect(batch.runs[0]?.protections).toEqual([
        { name: "access", status: "configured" },
      ]);
      expect(driver.sessions).toHaveLength(2);
      for (const session of driver.sessions) {
        expect(session.scopedHeaders).toEqual([{
          origins: ["https://staging.example.test"],
          headers: { "x-polymux-test-access": "static-protection-secret" },
        }]);
      }
      expect(driver.steps.map((step) => step.input.to).sort()).toEqual([
        "https://staging.example.test/buyer",
        "https://staging.example.test/seller",
      ]);
      expect(JSON.stringify(batch)).not.toContain("static-protection-secret");
      expect(JSON.stringify(events)).not.toContain("static-protection-secret");
    });
  });

  it("rejects missing secrets and production environments before opening sessions", async () => {
    const { projectDir, flowPath } = await writeProtectedFlow([
      "access:",
      "  origin: https://staging.example.test",
      "  headersFromEnv:",
      "    x-polymux-test-access: TEST_PROTECTION_TOKEN",
    ].join("\n"));
    const compiled = await compileCoordinatedFlowFile(flowPath);

    await withEnvironment({
      POLYMUX_TEST_ENVIRONMENT: "test",
      TEST_PROTECTION_TOKEN: undefined,
    }, async () => {
      const driver = new ProtectionDriver();
      await expect(runCoordinatedFlowInstances(compiled, driver, { projectDir }))
        .rejects.toThrow("needs environment variable TEST_PROTECTION_TOKEN");
      expect(driver.sessions).toEqual([]);
    });

    await withEnvironment({
      POLYMUX_TEST_ENVIRONMENT: "production",
      TEST_PROTECTION_TOKEN: "should-not-be-used",
    }, async () => {
      const driver = new ProtectionDriver();
      await expect(runCoordinatedFlowInstances(compiled, driver, { projectDir }))
        .rejects.toThrow("explicitly non-production");
      expect(driver.sessions).toEqual([]);
    });

    for (const environment of ["live", "production-eu", "main", "prd"]) {
      await withEnvironment({
        POLYMUX_TEST_ENVIRONMENT: environment,
        TEST_PROTECTION_TOKEN: "should-not-be-used",
      }, async () => {
        const driver = new ProtectionDriver();
        await expect(runCoordinatedFlowInstances(compiled, driver, { projectDir }))
          .rejects.toThrow("explicitly non-production");
        expect(driver.sessions).toEqual([]);
      });
    }
  });

  it("requires HTTPS except for local loopback origins", async () => {
    const { projectDir, flowPath } = await writeProtectedFlow([
      "access:",
      "  origin: http://staging.example.test",
      "  headersFromEnv:",
      "    x-polymux-test-access: TEST_PROTECTION_TOKEN",
    ].join("\n"));
    await withEnvironment({
      POLYMUX_TEST_ENVIRONMENT: "test",
      TEST_PROTECTION_TOKEN: "static-protection-secret",
    }, async () => {
      const driver = new ProtectionDriver();
      await expect(runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir },
      )).rejects.toThrow("requires HTTPS except on local loopback");
      expect(driver.sessions).toEqual([]);
    });
  });

  it("rejects the removed dynamic provider shape at compile time", async () => {
    const { flowPath } = await writeProtectedFlow([
      "access:",
      "  provider: cloudflare",
      "  input: { origin: https://staging.example.test }",
    ].join("\n"));
    await expect(compileCoordinatedFlowFile(flowPath))
      .rejects.toThrow("Invalid coordinated flow");
  });
});
