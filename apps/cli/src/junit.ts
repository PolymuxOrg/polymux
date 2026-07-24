import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CoordinatedFlowRunResult,
  RunResult,
  StepResult,
} from "@polymux/protocol";
import { effectiveRunStatus } from "@polymux/runner";

export type JUnitRun = RunResult | CoordinatedFlowRunResult;

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

function failedSteps(result: JUnitRun): StepResult[] {
  if ("steps" in result) {
    return result.steps.filter(
      (step) => step.status === "failed" || step.status === "error",
    );
  }
  return result.actors.flatMap(({ run }) =>
    run.steps.filter(
      (step) => step.status === "failed" || step.status === "error",
    ),
  );
}

function failureText(result: JUnitRun): string {
  const messages = failedSteps(result).map((step) => {
    const message = step.error?.message ?? step.message ?? step.status;
    return `${step.id} (${step.kind}): ${message}`;
  });
  return messages.length > 0 ? messages.join("\n") : `${result.flow}: ${result.status}`;
}

function testCase(result: JUnitRun): string {
  const conclusion = effectiveRunStatus(result);
  const instance = "instance" in result ? result.instance : result.instance ?? 1;
  const name = `${result.flow}${instance > 1 ? ` #${instance}` : ""}`;
  const tags = result.tags ?? [];
  const output = [
    tags.length > 0 ? `tags: ${tags.join(", ")}` : "",
    `artifacts: ${result.artifactsDir}`,
  ].filter(Boolean).join("\n");

  let body = "";
  if (result.knownFailure?.outcome === "expected-failure") {
    body += `<skipped message="${escapeXml(`Known failure: ${result.knownFailure.reason} (expires ${result.knownFailure.expires})`)}"/>`;
  } else if (result.knownFailure?.outcome === "unexpected-pass") {
    body += `<failure type="unexpected-pass" message="${escapeXml(`Known failure passed unexpectedly: ${result.knownFailure.reason}`)}">Remove or update knownFailure before merging.</failure>`;
  } else if (conclusion === "error") {
    body += `<error type="runtime" message="${escapeXml(failureText(result))}">${escapeXml(failureText(result))}</error>`;
  } else if (conclusion === "failed") {
    body += `<failure type="assertion" message="${escapeXml(failureText(result))}">${escapeXml(failureText(result))}</failure>`;
  }
  if (output) body += `<system-out>${escapeXml(output)}</system-out>`;

  return `<testcase classname="polymux" name="${escapeXml(name)}" time="${seconds(result.durationMs)}">${body}</testcase>`;
}

export function renderJUnit(runs: JUnitRun[]): string {
  const conclusions = runs.map(effectiveRunStatus);
  const failures = conclusions.filter((status) => status === "failed").length;
  const errors = conclusions.filter((status) => status === "error").length;
  const skipped = runs.filter(
    (run) => run.knownFailure?.outcome === "expected-failure",
  ).length;
  const duration = runs.reduce((total, run) => total + run.durationMs, 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="Polymux" tests="${runs.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(duration)}">`,
    ...runs.map(testCase),
    "</testsuite>",
    "",
  ].join("\n");
}

export async function writeJUnit(
  runs: JUnitRun[],
  output: string,
  projectDir: string,
): Promise<string> {
  const path = resolve(projectDir, output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderJUnit(runs), "utf8");
  return path;
}
