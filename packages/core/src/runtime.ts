import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, relative, resolve } from "node:path";
import type {
  CompiledFlowItem,
  CompiledStep,
  CompiledSingleActorFlow,
  RunEvent,
  RunResult,
  RunOrigin,
  StepResult,
  JsonValue,
} from "@polymux/protocol";
import type {
  Driver,
  DriverExecutionResult,
  DriverSession,
  ScopedHeaderRule,
} from "./driver.js";
import { missingCapabilities } from "./driver.js";
import { RuntimeFailure, FlowFailure } from "./errors.js";
import { writeRunReport } from "./report.js";

export interface ExecuteOptions {
  projectDir: string;
  artifactsRoot?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  scopedHeaders?: ScopedHeaderRule[];
  redactions?: string[];
  updateSnapshots?: boolean;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  origin?: RunOrigin;
  coordination?: ActorCoordination;
  email?: EmailCoordination;
  sms?: SmsCoordination;
  flowRunId?: string;
  actor?: string;
  instance?: number;
}

export interface ActorCoordination {
  signal(name: string, actor?: string): void | Promise<void>;
  waitForSignal(name: string, timeoutMs: number, actor?: string): Promise<void>;
}

export interface ReceiveEmailRequest {
  fixture: string;
  saveAs: string;
  timeoutMs: number;
  match?: {
    from?: string;
    subject?: string;
  };
  extract: Array<"otp" | "link">;
}

export interface ReceivedEmail {
  values: Record<string, JsonValue>;
  secrets: Record<string, JsonValue>;
  message?: string;
}

export interface EmailCoordination {
  receive(request: ReceiveEmailRequest, actor?: string): Promise<ReceivedEmail>;
}

export interface ReceiveSmsRequest {
  fixture: string;
  saveAs: string;
  timeoutMs: number;
  match?: {
    from?: string;
    body?: string;
  };
  extract: Array<"otp" | "link">;
}

export interface ReceivedSms {
  values: Record<string, JsonValue>;
  secrets: Record<string, JsonValue>;
  message?: string;
}

export interface SmsCoordination {
  receive(request: ReceiveSmsRequest, actor?: string): Promise<ReceivedSms>;
}

function timestampId(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function errorCategory(error: unknown): "assertion" | "runtime" {
  return error instanceof FlowFailure ? "assertion" : "runtime";
}

function redact(value: string, redactions: string[] = []): string {
  return redactions
    .filter((entry) => entry.length > 0)
    .reduce((result, entry) => result.replaceAll(entry, "[REDACTED]"), value);
}

function redactValue(value: unknown, redactions: string[] = []): unknown {
  if (typeof value === "string") return redact(value, redactions);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redactions));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, redactions)]),
    );
  }
  return value;
}

function secretStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(secretStrings);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(secretStrings);
  }
  return [];
}

function messagePath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      throw new RuntimeFailure(`Message variable "${path}" does not exist`);
    }
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) {
      throw new RuntimeFailure(`Message variable "${path}" does not exist`);
    }
  }
  return current;
}

function substituteMessages(value: unknown, messages: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = /^\$\{(messages\.[^}]+)\}$/.exec(value);
    if (exact) return messagePath({ messages }, exact[1]!);
    return value.replace(/\$\{(messages\.[^}]+)\}/g, (_match, path: string) => {
      const replacement = messagePath({ messages }, path);
      if (["string", "number", "boolean"].includes(typeof replacement)) {
        return String(replacement);
      }
      throw new RuntimeFailure(`Message variable "${path}" cannot be embedded in text`);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteMessages(entry, messages));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteMessages(entry, messages)]),
    );
  }
  return value;
}

function errorMessage(error: unknown, redactions: string[] = []): string {
  return redact(error instanceof Error ? error.message : String(error), redactions);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function relativeArtifacts(runDir: string, artifacts: string[]): string[] {
  return artifacts.map((artifact) => {
    const absolute = resolve(artifact);
    return relative(runDir, absolute);
  });
}

async function emit(
  callback: ExecuteOptions["onEvent"],
  event: RunEvent,
): Promise<void> {
  await callback?.(event);
}

function skippedResult(step: CompiledStep): StepResult {
  const now = new Date().toISOString();
  return {
    id: step.id,
    kind: step.kind,
    status: "skipped",
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    message: "Not applicable to this platform",
    artifacts: [],
  };
}

export async function executeSingleActorFlow(
  plan: CompiledSingleActorFlow,
  driver: Driver,
  options: ExecuteOptions,
): Promise<RunResult> {
  if (!plan.platforms.includes(driver.platform)) {
    throw new RuntimeFailure(
      `${plan.name} targets ${plan.platforms.join(", ")}, not ${driver.platform}`,
    );
  }
  const missing = missingCapabilities(plan, driver);
  if (missing.length > 0) {
    throw new RuntimeFailure(
      `Driver "${driver.id}" does not support:\n${missing.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (
    options.scopedHeaders &&
    options.scopedHeaders.length > 0 &&
    driver.supportsScopedHeaders !== true
  ) {
    throw new RuntimeFailure(
      `Driver "${driver.id}" cannot scope protection headers to application origins`,
    );
  }

  const started = new Date();
  const runId = `${timestampId()}-${slug(plan.name)}-${plan.hash.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
  const artifactsRoot = resolve(
    options.projectDir,
    options.artifactsRoot ?? ".polymux/runs",
  );
  const artifactsDir = resolve(artifactsRoot, runId);
  const eventContext = {
    ...(options.flowRunId ? { flowRunId: options.flowRunId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.instance !== undefined ? { instance: options.instance } : {}),
  };
  await mkdir(artifactsDir, { recursive: true });
  await emit(options.onEvent, {
    type: "run.started",
    runId,
    flow: plan.name,
    at: started.toISOString(),
    ...eventContext,
  });

  const stepResults: StepResult[] = [];
  const runArtifacts: string[] = [];
  const runtimeRedactions = [...(options.redactions ?? [])];
  const messages: Record<string, {
    values: Record<string, JsonValue>;
    secrets: Record<string, JsonValue>;
  }> = {};
  let status: RunResult["status"] = "passed";
  let session: DriverSession | undefined;
  try {
    session = await driver.createSession({
      plan,
      runId,
      projectDir: resolve(options.projectDir),
      artifactsDir,
      ...(options.baseUrl ?? plan.baseUrl
        ? { baseUrl: options.baseUrl ?? plan.baseUrl }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.scopedHeaders ? { scopedHeaders: options.scopedHeaders } : {}),
      containsSecrets:
        runtimeRedactions.length > 0
        || plan.requiredCapabilities.some((capability) =>
          capability.startsWith("messaging.")
        ),
      updateSnapshots: options.updateSnapshots ?? false,
    });

    const executeItems = async (
      items: CompiledFlowItem[],
      phase: "setup" | "steps" | "teardown",
      flowPath: string[],
    ): Promise<boolean> => {
      for (const item of items) {
        if (item.kind === "flow") {
          const childPassed = await executeLifecycle(
            item.flow,
            [...flowPath, item.flow.name],
          );
          if (!childPassed) return false;
          continue;
        }
        const currentStep = substituteMessages(
          {
            ...item,
            id: `${flowPath.join("/")}/${phase}/${item.id}`,
          },
          messages,
        ) as CompiledStep;
      if (
        currentStep.kind === "platform" &&
        currentStep.input.on !== driver.platform
      ) {
        const result = skippedResult(currentStep);
        stepResults.push(result);
        await emit(options.onEvent, {
          type: "step.finished",
          runId,
          result,
          at: result.finishedAt,
          ...eventContext,
        });
        continue;
      }

      const stepStarted = new Date();
      await emit(options.onEvent, {
        type: "step.started",
        runId,
        step: redactValue(currentStep, runtimeRedactions) as CompiledStep,
        at: stepStarted.toISOString(),
        ...eventContext,
      });
      try {
        let execution: DriverExecutionResult | void;
        if (currentStep.kind === "signal" || currentStep.kind === "waitForSignal") {
          if (!options.coordination) {
            throw new RuntimeFailure(
              `${currentStep.kind} requires a coordinated flow`,
            );
          }
          const name = String(currentStep.input.name);
          if (currentStep.kind === "signal") {
            await options.coordination.signal(name, options.actor);
            execution = { message: `Signalled ${name}` };
          } else {
            await options.coordination.waitForSignal(
              name,
              currentStep.timeoutMs,
              options.actor,
            );
            execution = { message: `Received ${name}` };
          }
        } else if (currentStep.kind === "receiveEmail") {
          if (!options.email) {
            throw new RuntimeFailure(
              "receiveEmail requires a coordinated flow with an inbox fixture",
            );
          }
          const rawMatch = currentStep.input.match;
          const match = typeof rawMatch === "object" && rawMatch !== null
            ? rawMatch as ReceiveEmailRequest["match"]
            : undefined;
          const extraction = currentStep.input.extract;
          if (
            !Array.isArray(extraction) ||
            extraction.some((item) => item !== "otp" && item !== "link")
          ) {
            throw new RuntimeFailure("receiveEmail has an invalid extraction plan");
          }
          const saveAs = String(currentStep.input.saveAs);
          const received = await options.email.receive({
            fixture: String(currentStep.input.fixture),
            saveAs,
            timeoutMs: currentStep.timeoutMs,
            ...(match ? { match } : {}),
            extract: extraction as Array<"otp" | "link">,
          }, options.actor);
          messages[saveAs] = {
            values: received.values,
            secrets: received.secrets,
          };
          runtimeRedactions.push(...secretStrings(received.secrets));
          execution = {
            message: received.message
              ?? `Received email and saved ${extraction.join(", ")} as ${saveAs}`,
          };
        } else if (currentStep.kind === "receiveSms") {
          if (!options.sms) {
            throw new RuntimeFailure(
              "receiveSms requires a coordinated flow with a phone fixture",
            );
          }
          const rawMatch = currentStep.input.match;
          const match = typeof rawMatch === "object" && rawMatch !== null
            ? rawMatch as ReceiveSmsRequest["match"]
            : undefined;
          const extraction = currentStep.input.extract;
          if (
            !Array.isArray(extraction)
            || extraction.some((item) => item !== "otp" && item !== "link")
          ) {
            throw new RuntimeFailure("receiveSms has an invalid extraction plan");
          }
          const saveAs = String(currentStep.input.saveAs);
          const received = await options.sms.receive({
            fixture: String(currentStep.input.fixture),
            saveAs,
            timeoutMs: currentStep.timeoutMs,
            ...(match ? { match } : {}),
            extract: extraction as Array<"otp" | "link">,
          }, options.actor);
          messages[saveAs] = {
            values: received.values,
            secrets: received.secrets,
          };
          runtimeRedactions.push(...secretStrings(received.secrets));
          execution = {
            message: received.message
              ?? `Received SMS and saved ${extraction.join(", ")} as ${saveAs}`,
          };
        } else {
          execution = await session!.execute(currentStep);
        }
        const finished = new Date();
        const result: StepResult = {
          id: currentStep.id,
          kind: currentStep.kind,
          phase,
          flowPath,
          status: "passed",
          startedAt: stepStarted.toISOString(),
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - stepStarted.getTime(),
          ...(execution?.message ? { message: redact(execution.message, runtimeRedactions) } : {}),
          ...(execution?.selectedStrategy
            ? { selectedStrategy: redactValue(
                execution.selectedStrategy,
                runtimeRedactions,
              ) as typeof execution.selectedStrategy }
            : {}),
          artifacts: relativeArtifacts(
            artifactsDir,
            execution?.artifacts ?? [],
          ),
        };
        stepResults.push(result);
        await emit(options.onEvent, {
          type: "step.finished",
          runId,
          result,
          at: result.finishedAt,
          ...eventContext,
        });
      } catch (error) {
        const category = errorCategory(error);
        const failureStatus = category === "assertion" ? "failed" : "error";
        if (status === "passed") status = failureStatus;
        let failureArtifacts: string[] = [];
        try {
          failureArtifacts =
            (await session!.captureFailure?.(currentStep)) ?? [];
        } catch {
          // Preserve the original failure if evidence capture also fails.
        }
        const finished = new Date();
        const result: StepResult = {
          id: currentStep.id,
          kind: currentStep.kind,
          phase,
          flowPath,
          status: failureStatus,
          startedAt: stepStarted.toISOString(),
          finishedAt: finished.toISOString(),
          durationMs: finished.getTime() - stepStarted.getTime(),
          artifacts: relativeArtifacts(artifactsDir, failureArtifacts),
          error: {
            name: errorName(error),
            message: errorMessage(error, runtimeRedactions),
            category,
          },
        };
        stepResults.push(result);
        await emit(options.onEvent, {
          type: "step.finished",
          runId,
          result,
          at: result.finishedAt,
          ...eventContext,
        });
        return false;
      }
      }
      return true;
    };
    const executeLifecycle = async (
      flow: CompiledSingleActorFlow,
      flowPath: string[],
    ): Promise<boolean> => {
      const setupPassed = await executeItems(flow.setup, "setup", flowPath);
      const stepsPassed = setupPassed
        ? await executeItems(flow.steps, "steps", flowPath)
        : false;
      const teardownPassed = await executeItems(flow.teardown, "teardown", flowPath);
      return setupPassed && stepsPassed && teardownPassed;
    };

    await executeLifecycle(plan, [plan.name]);
  } catch (error) {
    status = "error";
    const now = new Date();
    stepResults.push({
      id: "runtime",
      kind: "launch",
      status: "error",
      startedAt: started.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: now.getTime() - started.getTime(),
      artifacts: [],
      error: {
        name: errorName(error),
          message: errorMessage(error, runtimeRedactions),
        category: "runtime",
      },
    });
  } finally {
    if (session) {
      try {
        const closeArtifacts = await session.close();
        runArtifacts.push(...relativeArtifacts(artifactsDir, closeArtifacts ?? []));
      } catch (error) {
        if (status === "passed") {
          status = "error";
          const now = new Date();
          stepResults.push({
            id: "runtime-close",
            kind: "terminate",
            status: "error",
            startedAt: now.toISOString(),
            finishedAt: now.toISOString(),
            durationMs: 0,
            artifacts: [],
            error: {
              name: errorName(error),
              message: errorMessage(error, runtimeRedactions),
              category: "runtime",
            },
          });
        }
      }
    }
  }

  const finished = new Date();
  const result: RunResult = {
    formatVersion: 1,
    runId,
    flow: plan.name,
    flowHash: plan.hash,
    sourcePath: plan.sourcePath,
    tags: plan.tags,
    ...(plan.knownFailure
      ? {
          knownFailure: {
            ...plan.knownFailure,
            outcome: ((runStatus: RunResult["status"]) =>
              runStatus === "passed"
                ? "unexpected-pass"
                : runStatus === "failed"
                  ? "expected-failure"
                  : "error")(status),
          },
        }
      : {}),
    platform: driver.platform,
    origin: options.origin ?? {
      kind: "local",
      runnerId: hostname(),
      host: hostname(),
    },
    status,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    artifactsDir,
    artifacts: runArtifacts,
    steps: stepResults,
    ...(options.flowRunId ? { flowRunId: options.flowRunId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.instance !== undefined ? { instance: options.instance } : {}),
  };
  await writeRunReport(result);
  await emit(options.onEvent, {
    type: "run.finished",
    runId,
    result,
    at: finished.toISOString(),
    ...eventContext,
  });
  return result;
}
