import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RunOrigin, RunResult } from "@polymux/protocol";
import { cloudRequest } from "./cloud.js";

export interface RunQueryOptions {
  projectDir: string;
  remote: boolean;
  all: boolean;
  json: boolean;
  limit: number;
}

export interface RunShowOptions {
  projectDir: string;
  remote: boolean;
  json: boolean;
}

export interface DiagnosticOptions {
  projectDir: string;
  remote: boolean;
  output?: string;
  json: boolean;
}

export interface ReportOptions extends DiagnosticOptions {
  submit: boolean;
  message?: string;
}

export interface RunCleanOptions {
  projectDir: string;
  olderThan: number;
  yes: boolean;
  json: boolean;
}

export interface DiagnosticBundle {
  formatVersion: 1;
  generatedAt: string;
  polymuxVersion: string;
  run: {
    runId: string;
    flow: string;
    flowHash: string;
    platform: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    origin: RunOrigin;
    artifacts: string[];
    steps: Array<{
      id: string;
      kind: string;
      status: string;
      durationMs: number;
      message?: string;
      artifacts: string[];
      error?: { name: string; message: string; category: string };
    }>;
  };
  environment: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  privacy: {
    artifactContentsIncluded: false;
    redactionsApplied: string[];
  };
}

export interface ReportBundle {
  formatVersion: 1;
  runId: string;
  generatedAt: string;
  message?: string;
  diagnostic: DiagnosticBundle;
}

function isRunResult(value: unknown): value is RunResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunResult>;
  return typeof candidate.runId === "string" && typeof candidate.flow === "string" && Array.isArray(candidate.steps);
}

function fallbackOrigin(source: "local" | "remote"): RunOrigin {
  return { kind: source, runnerId: `${source}:unknown` };
}

function withOrigin(run: RunResult, source: "local" | "remote"): RunResult {
  return run.origin ? run : { ...run, origin: fallbackOrigin(source) };
}

export function originLabel(run: RunResult): string {
  const origin = run.origin ?? fallbackOrigin("local");
  return [origin.kind, origin.runnerId, origin.region].filter(Boolean).join(":");
}

async function localRuns(projectDir: string): Promise<RunResult[]> {
  const directory = resolve(projectDir, ".polymux/runs");
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, entry.name, "results.json"), "utf8"));
      return isRunResult(value) ? withOrigin(value, "local") : undefined;
    } catch {
      return undefined;
    }
  }));
  return runs.filter((run): run is RunResult => run !== undefined);
}

async function remoteRuns(limit: number): Promise<RunResult[]> {
  const response = await cloudRequest<{ runs: RunResult[] }>(`/api/runs?limit=${limit}`);
  return response.runs.filter(isRunResult).map((run) => withOrigin(run, "remote"));
}

function sorted(runs: RunResult[], limit: number): RunResult[] {
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit);
}

function printRuns(runs: RunResult[]): void {
  if (runs.length === 0) {
    process.stdout.write("No runs found.\n");
    return;
  }
  for (const run of runs) {
    process.stdout.write(`${run.runId}  ${run.status.padEnd(6)}  ${run.flow}  ${originLabel(run)}\n`);
  }
}

export async function listRuns(options: RunQueryOptions): Promise<void> {
  const sources = await Promise.all([
    options.remote && !options.all ? Promise.resolve([]) : localRuns(options.projectDir),
    options.remote || options.all ? remoteRuns(options.limit) : Promise.resolve([]),
  ]);
  const runs = sorted(sources.flat(), options.limit);
  if (options.json) process.stdout.write(`${JSON.stringify({ runs }, null, 2)}\n`);
  else printRuns(runs);
}

export async function cleanRuns(options: RunCleanOptions): Promise<void> {
  const directory = resolve(options.projectDir, ".polymux/runs");
  if (process.env.POLYMUX_VERBOSE === "1") process.stderr.write(`[polymux] runs-directory=${directory}\n`);
  const cutoff = Date.now() - options.olderThan * 24 * 60 * 60 * 1_000;
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") entries = [];
    else throw error;
  }
  const candidates: Array<{ runId: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    const metadata = await stat(path);
    if (metadata.mtimeMs < cutoff) candidates.push({ runId: entry.name, path });
  }
  if (options.yes) {
    for (const candidate of candidates) await rm(candidate.path, { recursive: true, force: true });
  }
  const result = { deleted: options.yes ? candidates.length : 0, candidates: candidates.map(({ runId }) => runId), dryRun: !options.yes, olderThanDays: options.olderThan };
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (!options.yes) process.stdout.write(`${candidates.length} run(s) would be removed. Re-run with --yes to confirm.\n`);
  else process.stdout.write(`Removed ${candidates.length} local run(s).\n`);
}

async function findLocalRun(runId: string, projectDir: string): Promise<RunResult | undefined> {
  return (await localRuns(projectDir)).find((run) => run.runId === runId);
}

async function getRun(runId: string, options: { projectDir: string; remote: boolean }): Promise<RunResult> {
  if (!options.remote) {
    const local = await findLocalRun(runId, options.projectDir);
    if (local) return local;
  }
  if (options.remote) {
    const response = await cloudRequest<{ run: RunResult }>(`/api/runs/${encodeURIComponent(runId)}`);
    if (isRunResult(response.run)) return withOrigin(response.run, "remote");
  }
  throw new Error(`Run "${runId}" was not found ${options.remote ? "in Polymux Cloud" : "locally"}`);
}

export async function showRun(runId: string, options: RunShowOptions): Promise<void> {
  const run = await getRun(runId, options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `${run.flow} (${run.runId})`,
    `Status: ${run.status}`,
    `Platform: ${run.platform}`,
    `Origin: ${originLabel(run)}`,
    `Started: ${run.startedAt}`,
    `Duration: ${run.durationMs} ms`,
    `Steps: ${run.steps.length}`,
    "",
  ].join("\n"));
}

function redact(value: string): string {
  return value
    .replaceAll(homedir(), "~")
    .replace(/pmx_[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function diagnostic(run: RunResult, version: string): DiagnosticBundle {
  const origin = run.origin ?? fallbackOrigin("local");
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    polymuxVersion: version,
    run: {
      runId: run.runId,
      flow: redact(run.flow),
      flowHash: run.flowHash,
      platform: run.platform,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      origin,
      artifacts: run.artifacts.map((artifact) => redact(artifact)),
      steps: run.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        durationMs: step.durationMs,
        ...(step.message ? { message: redact(step.message) } : {}),
        artifacts: step.artifacts.map((artifact) => redact(artifact)),
        ...(step.error ? { error: { ...step.error, message: redact(step.error.message) } } : {}),
      })),
    },
    environment: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    privacy: {
      artifactContentsIncluded: false,
      redactionsApplied: ["home-directory", "Polymux tokens", "Bearer tokens", "sensitive URL parameters"],
    },
  };
}

async function writeDiagnostic(runId: string, bundle: DiagnosticBundle, options: DiagnosticOptions): Promise<string> {
  const path = resolve(options.output ?? join(options.projectDir, ".polymux/diagnostics", `${runId}.json`));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function reportMessage(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const message = value.trim();
  if (message.length === 0) throw new Error("Report message cannot be empty");
  if (message.length > 4_000) throw new Error("Report message must be 4,000 characters or fewer");
  return message;
}

async function writeReport(runId: string, bundle: ReportBundle, options: ReportOptions): Promise<string> {
  const path = resolve(options.output ?? join(options.projectDir, ".polymux/reports", `${runId}.json`));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function diagnoseRun(runId: string, version: string, options: DiagnosticOptions): Promise<DiagnosticBundle> {
  const run = await getRun(runId, options);
  const bundle = diagnostic(run, version);
  const path = await writeDiagnostic(runId, bundle, options);
  if (options.json) process.stdout.write(`${JSON.stringify({ path, diagnostic: bundle }, null, 2)}\n`);
  else process.stdout.write(`Diagnostic written to ${path}\nOrigin: ${originLabel(run)}\n`);
  return bundle;
}

export async function reportRun(runId: string, version: string, options: ReportOptions): Promise<void> {
  const run = await getRun(runId, options);
  const diagnosticBundle = diagnostic(run, version);
  const message = reportMessage(options.message);
  const bundle: ReportBundle = {
    formatVersion: 1,
    runId,
    generatedAt: diagnosticBundle.generatedAt,
    ...(message ? { message } : {}),
    diagnostic: diagnosticBundle,
  };
  const path = await writeReport(runId, bundle, options);
  if (!options.submit) {
    if (options.json) process.stdout.write(`${JSON.stringify({ submitted: false, path, report: bundle }, null, 2)}\n`);
    else process.stdout.write(`Report prepared at ${path}\nReview it, then submit with \`polymux report ${runId} --submit${options.remote ? " --remote" : ""}\`.\n`);
    return;
  }
  const response = await cloudRequest<{ reportId: string }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({
      runId,
      origin: run.origin ?? fallbackOrigin(options.remote ? "remote" : "local"),
      ...(message ? { message } : {}),
      diagnostic: diagnosticBundle,
    }),
  });
  if (options.json) process.stdout.write(`${JSON.stringify({ submitted: true, reportId: response.reportId, path }, null, 2)}\n`);
  else process.stdout.write(`Report submitted: ${response.reportId}\nLocal copy: ${path}\n`);
}
