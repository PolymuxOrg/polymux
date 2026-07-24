import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = join(repositoryRoot, "tests/fixtures/animation-memory-gallery");
const cliPath = join(repositoryRoot, "apps/cli/dist/index.js");

interface RunResult {
  flow: string;
  status: "passed" | "failed" | "error";
}

interface BatchResult {
  status: "passed" | "failed" | "error";
  runs: RunResult[];
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
      () => rejectReady(new Error(`${variant} animation gallery did not start`)),
      5_000,
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`Animation memory gallery (${variant})`)) {
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
  options: { updateSnapshots?: boolean; repeat?: number } = {},
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
    if (options.updateSnapshots) args.push("--update-snapshots");
    if (options.repeat) args.push("--repeat", String(options.repeat));
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
  "detects temporary animation defects that a final-frame check misses",
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-animation-memory-"));
    await cp(fixtureRoot, projectDir, { recursive: true });
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const fixedServer = await startGallery(projectDir, port, "fixed");
    try {
      const baseline = await runGallery(
        projectDir,
        baseUrl,
        join(projectDir, "artifacts/baseline"),
        { updateSnapshots: true },
      );
      expect(baseline.code, baseline.stderr).toBe(0);

      const fixed = await runGallery(
        projectDir,
        baseUrl,
        join(projectDir, "artifacts/fixed"),
        { repeat: 2 },
      );
      expect(fixed.code, fixed.stderr).toBe(0);
      expect(fixed.batch.runs).toHaveLength(12);
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
        { repeat: 2 },
      );
      const finalOnly = broken.batch.runs.filter((run) =>
        run.flow.includes("final frame only"),
      );
      const timeline = broken.batch.runs.filter((run) =>
        run.flow.includes("timeline memory"),
      );

      expect(broken.code).toBe(1);
      expect(finalOnly).toHaveLength(6);
      expect(finalOnly.every((run) => run.status === "passed")).toBe(true);
      expect(timeline).toHaveLength(6);
      expect(timeline.every((run) => run.status === "failed")).toBe(true);
    } finally {
      await stopGallery(brokenServer);
    }
  },
  60_000,
);
