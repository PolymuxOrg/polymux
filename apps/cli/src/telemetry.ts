import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PostHog } from "posthog-node";
import { configValue } from "./config.js";
import { configDirectory } from "./paths.js";

interface TelemetryIdentity {
  formatVersion: 1;
  anonymousId: string;
}

export interface TelemetryContext {
  command: string;
  version: string;
  json: boolean;
}

export interface TelemetrySession {
  captureException(error: unknown): void;
  finish(exitCode: number): Promise<void>;
}

const identityPath = (): string => join(configDirectory(), "telemetry.json");
// PostHog project API keys are public ingestion identifiers, not secrets.
const defaultPostHogKey = "phc_y6Atu7kg2S8tNMjBhjKbN6qFqw48zXTU7qTMrmuhCCAw"; // gitleaks:allow
const defaultPostHogHost = "https://us.i.posthog.com";

function postHogKey(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.POLYMUX_POSTHOG_KEY?.trim() || defaultPostHogKey;
}

export function telemetryEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (!configValue<boolean>("telemetry.enabled")) return false;
  if (environment.POLYMUX_TELEMETRY_DISABLED === "1" || environment.DO_NOT_TRACK === "1") return false;
  return true;
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  return new Set([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "FlowCompileError",
    "FlowFailure",
    "RuntimeFailure",
  ]).has(error.name)
    ? error.name
    : "Error";
}

async function loadIdentity(): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(identityPath(), "utf8")) as Partial<TelemetryIdentity>;
    if (parsed.formatVersion === 1 && typeof parsed.anonymousId === "string" && parsed.anonymousId.length > 0) {
      return parsed.anonymousId;
    }
  } catch {
    // A missing or invalid identity is safely replaced with a new anonymous ID.
  }
  const identity: TelemetryIdentity = { formatVersion: 1, anonymousId: randomUUID() };
  await mkdir(dirname(identityPath()), { recursive: true, mode: 0o700 });
  await writeFile(identityPath(), `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(identityPath(), 0o600);
  return identity.anonymousId;
}

function baseProperties(context: TelemetryContext): Record<string, string | number | boolean> {
  return {
    command: context.command,
    polymux_version: context.version,
    node_major: Number(process.versions.node.split(".")[0]),
    platform: process.platform,
    architecture: process.arch,
    ci: Boolean(process.env.CI),
    json: context.json,
    telemetry_source: "polymux-cli",
    $process_person_profile: false,
  };
}

export async function startTelemetry(context: TelemetryContext): Promise<TelemetrySession | undefined> {
  try {
    if (!telemetryEnabled()) return undefined;
    const [{ PostHog }, anonymousId] = await Promise.all([import("posthog-node"), loadIdentity()]);
    const client: PostHog = new PostHog(postHogKey(), {
      host: process.env.POLYMUX_POSTHOG_HOST?.trim() || defaultPostHogHost,
      flushAt: 1,
      flushInterval: 0,
      requestTimeout: 1_000,
      disableGeoip: true,
      enableExceptionAutocapture: false,
      isServer: false,
    });
    const startedAt = performance.now();
    const properties = baseProperties(context);
    let capturedError = false;

    return {
      captureException(error: unknown): void {
        try {
          capturedError = true;
          client.capture({
            distinctId: anonymousId,
            event: "cli command exception",
            properties: {
              ...properties,
              error_type: errorType(error),
            },
          });
        } catch {
          // Telemetry must never change the CLI result.
        }
      },
      async finish(exitCode: number): Promise<void> {
        try {
          client.capture({
            distinctId: anonymousId,
            event: "cli command completed",
            properties: {
              ...properties,
              duration_ms: Math.round(performance.now() - startedAt),
              exit_code: exitCode,
              success: exitCode === 0,
              error_captured: capturedError,
            },
          });
          await client.shutdown(250).catch(() => undefined);
        } catch {
          // Telemetry must never change the CLI result.
        }
      },
    };
  } catch {
    return undefined;
  }
}
