import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { startTelemetry, telemetryEnabled } from "../apps/cli/src/telemetry.js";

describe("CLI telemetry privacy", () => {
  it("is enabled by default and honors both opt-out controls", () => {
    expect(telemetryEnabled({ ...process.env, POLYMUX_POSTHOG_KEY: "" })).toBe(true);
    expect(telemetryEnabled({
      ...process.env,
      POLYMUX_POSTHOG_KEY: "phc_test",
      POLYMUX_TELEMETRY_DISABLED: "1",
    })).toBe(false);
    expect(telemetryEnabled({
      ...process.env,
      POLYMUX_POSTHOG_KEY: "phc_test",
      DO_NOT_TRACK: "1",
    })).toBe(false);
  });

  it("sends bounded anonymous completion and error-category events", async () => {
    const events: Array<{ event?: string; properties?: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      const payload = JSON.parse(body.toString("utf8")) as {
        batch?: Array<{ event?: string; properties?: Record<string, unknown> }>;
      };
      events.push(...(payload.batch ?? []));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No telemetry test port");

    const previous = {
      config: process.env.POLYMUX_CONFIG_DIR,
      key: process.env.POLYMUX_POSTHOG_KEY,
      host: process.env.POLYMUX_POSTHOG_HOST,
    };
    process.env.POLYMUX_CONFIG_DIR = await mkdtemp(join(tmpdir(), "polymux-telemetry-test-"));
    process.env.POLYMUX_POSTHOG_KEY = "phc_test";
    process.env.POLYMUX_POSTHOG_HOST = `http://127.0.0.1:${address.port}`;
    try {
      const session = await startTelemetry({ command: "run", version: "1.2.3", json: false });
      expect(session).toBeDefined();
      session!.captureException(new Error(
        "Bearer private-token failed for secret-flow at /private/project and https://example.test",
      ));
      await session!.finish(2);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (previous.config === undefined) delete process.env.POLYMUX_CONFIG_DIR;
      else process.env.POLYMUX_CONFIG_DIR = previous.config;
      if (previous.key === undefined) delete process.env.POLYMUX_POSTHOG_KEY;
      else process.env.POLYMUX_POSTHOG_KEY = previous.key;
      if (previous.host === undefined) delete process.env.POLYMUX_POSTHOG_HOST;
      else process.env.POLYMUX_POSTHOG_HOST = previous.host;
    }

    const completion = events.find((event) => event.event === "cli command completed");
    const exception = events.find((event) => event.event === "cli command exception");
    expect(completion?.properties).toMatchObject({
      command: "run",
      polymux_version: "1.2.3",
      telemetry_source: "polymux-cli",
      exit_code: 2,
      success: false,
      error_captured: true,
      $process_person_profile: false,
      $geoip_disable: true,
    });
    const serializedException = JSON.stringify(exception);
    expect(serializedException).not.toContain("private-token");
    expect(serializedException).not.toContain("secret-flow");
    expect(serializedException).not.toContain("/private/project");
    expect(serializedException).not.toContain("example.test");
    expect(exception?.properties).toMatchObject({
      command: "run",
      error_type: "Error",
    });
  });
});
