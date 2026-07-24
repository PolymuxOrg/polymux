import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSingleActorFlowFiles,
  executeSingleActorFlow,
  missingCapabilities,
  RuntimeFailure,
  type Driver,
  type ExecuteOptions,
  type ActorCoordination,
} from "@polymux/core";
import type {
  CompiledCoordinatedFlow,
  RunResult,
  CoordinatedFlowRunResult,
} from "@polymux/protocol";
import { FlowFixtures } from "./fixtures.js";

export interface RunSingleActorFlowFilesOptions
  extends Omit<ExecuteOptions, "onEvent" | "instance"> {
  onEvent?: ExecuteOptions["onEvent"];
  concurrency?: number;
  repeat?: number;
}

export interface BatchResult {
  status: "passed" | "failed" | "error";
  concurrency: number;
  runs: RunResult[];
}

export interface RunCoordinatedFlowInstancesOptions
  extends Omit<
    ExecuteOptions,
    "coordination" | "email" | "sms" | "flowRunId" | "actor" | "instance"
  > {
  concurrency?: number;
  instances?: number;
  executionMode?: "local" | "cloud";
  fixtureEnvironment?: NodeJS.ProcessEnv;
}

export interface CoordinatedFlowBatchResult {
  status: "passed" | "failed" | "error";
  concurrency: number;
  runs: CoordinatedFlowRunResult[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

export function automaticConcurrency(
  driver: Driver,
  workItems: number,
  sessionsPerItem = 1,
): number {
  if (workItems === 0 || driver.platform !== "web") return 1;
  const cpuCapacity = Math.max(1, Math.floor(availableParallelism() / 2));
  const memoryCapacity = Math.max(
    1,
    Math.floor((totalmem() / 1024 ** 3 - 2) / 1.5),
  );
  const sessionCapacity = Math.min(8, cpuCapacity, memoryCapacity);
  return Math.max(1, Math.min(workItems, Math.floor(sessionCapacity / sessionsPerItem)));
}

export async function schedule<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = positiveInteger(concurrency, "concurrency");
  const results = new Array<R>(items.length);
  let next = 0;
  async function consume(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => consume()),
  );
  return results;
}

export function effectiveRunStatus(result: {
  status: "passed" | "failed" | "error";
  knownFailure?: { outcome: "expected-failure" | "unexpected-pass" | "error" };
}): "passed" | "failed" | "error" {
  if (result.status === "error" || result.knownFailure?.outcome === "error") {
    return "error";
  }
  if (result.knownFailure?.outcome === "expected-failure") return "passed";
  if (result.knownFailure?.outcome === "unexpected-pass") return "failed";
  return result.status;
}

function batchStatus(results: Array<{
  status: "passed" | "failed" | "error";
  knownFailure?: { outcome: "expected-failure" | "unexpected-pass" | "error" };
}>):
  "passed" | "failed" | "error" {
  const statuses = results.map(effectiveRunStatus);
  return statuses.includes("error")
    ? "error"
    : statuses.includes("failed")
      ? "failed"
      : "passed";
}

export async function runSingleActorFlowFiles(
  files: string[],
  driver: Driver,
  options: RunSingleActorFlowFilesOptions,
): Promise<BatchResult> {
  const builds = await buildSingleActorFlowFiles(files, options.projectDir);
  const repeat = positiveInteger(options.repeat ?? 1, "repeat");
  const work = builds.flatMap(({ plan }) =>
    Array.from({ length: repeat }, (_, index) => ({ plan, instance: index + 1 })),
  );
  if (options.updateSnapshots && repeat > 1) {
    throw new RangeError("Snapshot updates cannot be combined with repeated runs");
  }
  const concurrency = options.updateSnapshots
    ? 1
    : options.concurrency === undefined
      ? automaticConcurrency(driver, work.length)
      : positiveInteger(options.concurrency, "concurrency");
  const runs = await schedule(
    work,
    concurrency,
    ({ plan, instance }) => executeSingleActorFlow(plan, driver, {
      projectDir: options.projectDir,
      ...(options.artifactsRoot ? { artifactsRoot: options.artifactsRoot } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.updateSnapshots !== undefined
        ? { updateSnapshots: options.updateSnapshots }
        : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(repeat > 1 ? { instance } : {}),
    }),
  );
  return { status: batchStatus(runs), concurrency, runs };
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class FlowCoordination implements ActorCoordination {
  private readonly signals = new Set<string>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private aborted?: Error;

  signal(name: string): void {
    if (this.aborted) throw this.aborted;
    this.signals.add(name);
    for (const waiter of this.waiters.get(name) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters.delete(name);
  }

  waitForSignal(name: string, timeoutMs: number, actor?: string): Promise<void> {
    if (this.aborted) return Promise.reject(this.aborted);
    if (this.signals.has(name)) return Promise.resolve();
    return new Promise((resolveWait, rejectWait) => {
      const waiters = this.waiters.get(name) ?? new Set<Waiter>();
      const waiter: Waiter = {
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          rejectWait(new RuntimeFailure(
            `${actor ? `Actor "${actor}"` : "Actor"} timed out waiting for signal "${name}"`,
          ));
        }, timeoutMs),
      };
      waiters.add(waiter);
      this.waiters.set(name, waiters);
    });
  }

  abort(error: Error): void {
    if (this.aborted) return;
    this.aborted = error;
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.waiters.clear();
  }
}

function timestampId(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function writeCoordinatedFlowReport(result: CoordinatedFlowRunResult): Promise<void> {
  await writeFile(
    join(result.artifactsDir, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  const rows = result.actors.map(({ actor, run }) =>
    `<tr><td>${escapeHtml(actor)}</td><td>${escapeHtml(run.flow)}</td><td>${run.status}</td><td>${run.durationMs} ms</td><td><a href="actors/${escapeHtml(run.runId)}/report.html">report</a></td></tr>`,
  ).join("");
  const fixtureRows = result.fixtures.map((fixture) =>
    `<tr><td>${escapeHtml(fixture.name)}</td><td>${escapeHtml(fixture.type)}</td><td>${escapeHtml(fixture.provider)}</td><td>${fixture.status}</td></tr>`,
  ).join("");
  const protectionRows = result.protections.map((protection) =>
    `<tr><td>${escapeHtml(protection.name)}</td><td>${protection.status}</td></tr>`,
  ).join("");
  const knownFailure = result.knownFailure
    ? `<p><strong>Known failure: ${escapeHtml(result.knownFailure.outcome)}</strong> · ${escapeHtml(result.knownFailure.reason)} · expires ${escapeHtml(result.knownFailure.expires)}</p>`
    : "";
  await writeFile(
    join(result.artifactsDir, "report.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(result.flow)}</title><style>body{font:14px system-ui;max-width:960px;margin:40px auto;padding:0 20px}table{border-collapse:collapse;width:100%;margin-bottom:32px}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}</style></head><body><h1>${escapeHtml(result.flow)}</h1><p>Status: ${result.status} · ${result.durationMs} ms</p>${knownFailure}<h2>Actors</h2><table><thead><tr><th>Actor</th><th>Flow</th><th>Status</th><th>Duration</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>${protectionRows ? `<h2>Test access</h2><table><thead><tr><th>Protection</th><th>Status</th></tr></thead><tbody>${protectionRows}</tbody></table>` : ""}${fixtureRows ? `<h2>Fixtures</h2><table><thead><tr><th>Fixture</th><th>Type</th><th>Provider</th><th>Status</th></tr></thead><tbody>${fixtureRows}</tbody></table>` : ""}</body></html>`,
    "utf8",
  );
}

export async function runCoordinatedFlow(
  flow: CompiledCoordinatedFlow,
  driver: Driver,
  options: Omit<RunCoordinatedFlowInstancesOptions, "concurrency" | "instances"> & { instance?: number },
): Promise<CoordinatedFlowRunResult> {
  const executionMode = options.executionMode ?? "local";
  if (executionMode === "cloud" && options.fixtureEnvironment === undefined) {
    throw new RuntimeFailure(
      "Cloud execution requires an explicit, per-run fixture environment",
    );
  }
  const instance = options.instance ?? 1;
  const started = new Date();
  const flowRunId = `${timestampId()}-${slug(flow.name)}-${flow.hash.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const root = resolve(options.projectDir, options.artifactsRoot ?? ".polymux/runs");
  const artifactsDir = join(root, flowRunId);
  await mkdir(join(artifactsDir, "actors"), { recursive: true });
  const coordination = new FlowCoordination();
  for (const actor of flow.actors) {
    if (!actor.flow.platforms.includes(driver.platform)) {
      throw new RuntimeFailure(
        `Actor "${actor.name}" targets ${actor.flow.platforms.join(", ")}, not ${driver.platform}`,
      );
    }
    const missing = missingCapabilities(actor.flow, driver);
    if (missing.length > 0) {
      throw new RuntimeFailure(
        `Actor "${actor.name}" cannot run on driver "${driver.id}":\n${missing.map((item) => `- ${item}`).join("\n")}`,
      );
    }
  }
  const seed = createHash("sha256")
    .update(`${flow.hash}:${flowRunId}:${instance}`)
    .digest("hex")
    .slice(0, 24);
  const fixtureManager = new FlowFixtures(flow, {
    flowRunId,
    instance,
    seed,
  }, options.fixtureEnvironment ?? process.env, executionMode);
  try {
    await fixtureManager.createAll();
  } catch (error) {
    await fixtureManager.cleanup();
    throw error;
  }
  const settledActors = await Promise.allSettled(
    flow.actors.map(async (actor) => {
      try {
        const prepared = fixtureManager.actor(actor);
        const run = await executeSingleActorFlow(prepared.flow, driver, {
          projectDir: options.projectDir,
          artifactsRoot: join(artifactsDir, "actors"),
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.updateSnapshots !== undefined ? { updateSnapshots: options.updateSnapshots } : {}),
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(Object.keys(prepared.headers).length > 0 ? { headers: prepared.headers } : {}),
          ...(prepared.scopedHeaders.length > 0
            ? { scopedHeaders: prepared.scopedHeaders }
            : {}),
          ...(prepared.redactions.length > 0 ? { redactions: prepared.redactions } : {}),
          coordination,
          email: prepared.email,
          sms: prepared.sms,
          flowRunId,
          actor: actor.name,
          instance,
        });
        if (run.status !== "passed") {
          coordination.abort(new RuntimeFailure(
            `Actor "${actor.name}" ${run.status}`,
          ));
        }
        return { actor: actor.name, run };
      } catch (error) {
        coordination.abort(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }),
  );
  const rejected = settledActors.find((actor) => actor.status === "rejected");
  if (rejected?.status === "rejected") {
    await fixtureManager.cleanup();
    throw rejected.reason;
  }
  const actors = settledActors.map((actor) => {
    if (actor.status === "rejected") throw actor.reason;
    return actor.value;
  });
  await fixtureManager.cleanup();
  const finished = new Date();
  const actorStatus = batchStatus(actors.map(({ run }) => run));
  const status = fixtureManager.hasCleanupFailures() ? "error" : actorStatus;
  const result: CoordinatedFlowRunResult = {
    formatVersion: 1,
    flowRunId,
    flow: flow.name,
    flowHash: flow.hash,
    sourcePath: flow.sourcePath,
    tags: flow.tags,
    ...(flow.knownFailure
      ? {
          knownFailure: {
            ...flow.knownFailure,
            outcome:
              status === "passed"
                ? "unexpected-pass"
                : status === "failed"
                  ? "expected-failure"
                  : "error",
          },
        }
      : {}),
    instance,
    status,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    artifactsDir,
    protections: fixtureManager.protectionSummaries(),
    fixtures: fixtureManager.summaries(),
    actors,
  };
  await writeCoordinatedFlowReport(result);
  return result;
}

export async function runCoordinatedFlowInstances(
  flow: CompiledCoordinatedFlow,
  driver: Driver,
  options: RunCoordinatedFlowInstancesOptions,
): Promise<CoordinatedFlowBatchResult> {
  const instances = positiveInteger(options.instances ?? 1, "instances");
  if (options.updateSnapshots && instances > 1) {
    throw new RangeError("Snapshot updates cannot be combined with repeated coordinated flows");
  }
  const concurrency = options.updateSnapshots
    ? 1
    : options.concurrency === undefined
      ? automaticConcurrency(driver, instances, flow.actors.length)
      : positiveInteger(options.concurrency, "concurrency");
  const work = Array.from({ length: instances }, (_, index) => index + 1);
  const runs = await schedule(
    work,
    concurrency,
    (instance) => runCoordinatedFlow(flow, driver, { ...options, instance }),
  );
  return { status: batchStatus(runs), concurrency, runs };
}
