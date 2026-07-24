import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function runCli(args: string[], cwd: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [join(repositoryRoot, "apps/cli/dist/index.js"), ...args],
      {
        cwd,
        env: {
          ...process.env,
          POLYMUX_NO_UPDATE_CHECK: "1",
          POLYMUX_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      resolveRun({ code: code ?? -1, stdout, stderr }),
    );
  });
}

describe("CLI flow metadata", () => {
  it("filters builds with tags while preserving directory selectors", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-tags-"));
    await mkdir(join(projectDir, "polymux/checkout"), { recursive: true });
    await writeFile(
      join(projectDir, "polymux/checkout/smoke.flow.yaml"),
      "version: 1\nname: Smoke\ntags: [smoke, critical]\nsteps:\n  - wait: 1\n",
    );
    await writeFile(
      join(projectDir, "polymux/checkout/full.flow.yaml"),
      "version: 1\nname: Full\ntags: [slow]\nsteps:\n  - wait: 1\n",
    );

    const included = await runCli([
      "build",
      "checkout",
      "--include-tags",
      "smoke",
      "--project-dir",
      projectDir,
      "--json",
    ], projectDir);
    expect(included.code, included.stderr).toBe(0);
    expect(JSON.parse(included.stdout).builds).toMatchObject([
      { flow: "Smoke" },
    ]);

    const excluded = await runCli([
      "build",
      "checkout",
      "--exclude-tags",
      "slow",
      "--project-dir",
      projectDir,
      "--json",
    ], projectDir);
    expect(excluded.code, excluded.stderr).toBe(0);
    expect(JSON.parse(excluded.stdout).builds).toMatchObject([
      { flow: "Smoke" },
    ]);
  });
});
