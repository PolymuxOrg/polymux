import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = join(repositoryRoot, "tests/fixtures/ui-regression-gallery");
const cliPath = join(repositoryRoot, "apps/cli/dist/index.js");

interface BatchRun {
  status: "passed" | "failed" | "error";
  steps: Array<{ status: "passed" | "failed" | "error" }>;
}

interface BatchResult {
  status: "passed" | "failed" | "error";
  runs: BatchRun[];
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a test port");
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function startGallery(
  projectDir: string,
  port: number,
  variant: "fixed" | "broken",
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), VARIANT: variant },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`${variant} gallery did not start`)),
      5_000,
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`UI regression gallery (${variant})`)) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("error", rejectReady);
  });
  return child;
}

async function stopGallery(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.kill("SIGTERM");
  });
}

async function runGallery(
  projectDir: string,
  baseUrl: string,
  output: string,
  updateSnapshots = false,
): Promise<{ code: number; batch: BatchResult; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      cliPath,
      "run",
      "--project-dir",
      projectDir,
      "--url",
      baseUrl,
      "--output",
      output,
      "--json",
    ];
    if (updateSnapshots) args.push("--update-snapshots");
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      resolveRun({
        code: code ?? -1,
        batch: JSON.parse(stdout) as BatchResult,
        stderr,
      });
    });
  });
}

it(
  "passes 20 clean UI flows and detects all 20 deliberate regressions",
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-ui-gallery-"));
    await cp(fixtureRoot, projectDir, { recursive: true });
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const fixedServer = await startGallery(projectDir, port, "fixed");
    try {
      const baseline = await runGallery(
        projectDir,
        baseUrl,
        join(projectDir, "artifacts/baseline"),
        true,
      );
      expect(baseline.code, baseline.stderr).toBe(0);
      expect(baseline.batch.runs).toHaveLength(20);

      const fixed = await runGallery(
        projectDir,
        baseUrl,
        join(projectDir, "artifacts/fixed"),
      );
      expect(fixed.code, fixed.stderr).toBe(0);
      expect(fixed.batch.status).toBe("passed");
      expect(fixed.batch.runs).toHaveLength(20);
      expect(fixed.batch.runs.every((run) => run.status === "passed")).toBe(true);
    } finally {
      await stopGallery(fixedServer);
    }

    const brokenServer = await startGallery(projectDir, port, "broken");
    try {
      const broken = await runGallery(
        projectDir,
        baseUrl,
        join(projectDir, "artifacts/broken"),
      );
      expect(broken.code).toBe(1);
      expect(broken.batch.status).toBe("failed");
      expect(broken.batch.runs).toHaveLength(20);
      expect(broken.batch.runs.every((run) => run.status === "failed")).toBe(true);
      expect(
        broken.batch.runs.every((run) =>
          run.steps.some((step) => step.status === "failed"),
        ),
      ).toBe(true);
    } finally {
      await stopGallery(brokenServer);
    }
  },
  75_000,
);
