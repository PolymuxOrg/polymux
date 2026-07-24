import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult, StepResult } from "@polymux/protocol";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status: StepResult["status"]): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Error";
}

export function renderHtmlReport(result: RunResult): string {
  const origin = result.origin
    ? `${result.origin.kind}:${result.origin.runnerId}${result.origin.region ? ` · ${result.origin.region}` : ""}`
    : "local:unknown";
  const stepRows = result.steps
    .map(
      (step) => `
        <article class="step ${escapeHtml(step.status)}">
          <div class="step-heading">
            <span class="status">${statusLabel(step.status)}</span>
            <strong>${escapeHtml(step.id)}</strong>
            <span>${step.durationMs} ms</span>
          </div>
          ${step.phase ? `<small>${escapeHtml(step.phase)}${step.flowPath ? ` · ${escapeHtml(step.flowPath.join(" / "))}` : ""}</small>` : ""}
          ${step.message ? `<p>${escapeHtml(step.message)}</p>` : ""}
          ${
            step.error
              ? `<pre>${escapeHtml(step.error.message)}</pre>`
              : ""
          }
          ${
            step.artifacts.length > 0
              ? `<ul>${step.artifacts
                  .map(
                    (artifact) =>
                      `<li><a href="${escapeHtml(artifact)}">${escapeHtml(artifact)}</a></li>`,
                  )
                  .join("")}</ul>`
              : ""
          }
        </article>`,
    )
    .join("");
  const knownFailure = result.knownFailure
    ? `<aside class="attention"><strong>Known failure: ${escapeHtml(result.knownFailure.outcome)}</strong><br>${escapeHtml(result.knownFailure.reason)} · expires ${escapeHtml(result.knownFailure.expires)}</aside>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(result.flow)} · Polymux</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 960px; margin: 0 auto; padding: 48px 24px; background: #0b0d10; color: #e8eaed; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 36px; }
    h1 { margin: 0; font-size: 32px; letter-spacing: -0.03em; }
    .summary { color: #aab0b8; }
    .badge { border-radius: 999px; padding: 7px 12px; font-weight: 700; text-transform: uppercase; font-size: 12px; }
    .badge.passed { background: #103d2b; color: #6ee7a7; }
    .badge.failed, .badge.error { background: #4a171b; color: #ff9da5; }
    .attention { border: 1px solid #d9a441; background: #2a2110; color: #f2cf75; border-radius: 12px; padding: 14px 16px; margin-bottom: 24px; }
    .step { border: 1px solid #2a2f36; border-radius: 12px; padding: 16px; margin: 12px 0; background: #12161b; }
    .step-heading { display: grid; grid-template-columns: 80px 1fr auto; gap: 16px; align-items: center; }
    .status { color: #aab0b8; font-size: 13px; }
    .step.passed { border-left: 3px solid #2ecf7f; }
    .step.failed, .step.error { border-left: 3px solid #ef6570; }
    .step.skipped { opacity: .65; }
    pre { white-space: pre-wrap; color: #ffb4b9; background: #211317; padding: 12px; border-radius: 8px; }
    a { color: #8ab4f8; }
    footer { margin-top: 36px; color: #737b86; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(result.flow)}</h1>
      <div class="summary">${result.steps.filter((s) => s.status === "passed").length} passed · ${result.steps.filter((s) => s.status === "failed").length} failed · ${result.durationMs} ms</div>
    </div>
    <span class="badge ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span>
  </header>
  ${knownFailure}
  <main>${stepRows}</main>
  ${
    result.artifacts.length > 0
      ? `<section><h2>Run artifacts</h2><ul>${result.artifacts
          .map(
            (artifact) =>
              `<li><a href="${escapeHtml(artifact)}">${escapeHtml(artifact)}</a></li>`,
          )
          .join("")}</ul></section>`
      : ""
  }
  <footer>Run ${escapeHtml(result.runId)} · ${escapeHtml(result.platform)} · ${escapeHtml(origin)} · Polymux</footer>
</body>
</html>`;
}

export async function writeRunReport(result: RunResult): Promise<void> {
  await Promise.all([
    writeFile(
      join(result.artifactsDir, "results.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(result.artifactsDir, "report.html"),
      renderHtmlReport(result),
      "utf8",
    ),
  ]);
}
