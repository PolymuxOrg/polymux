import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriver } from "@polymux/adapter-web";
import {
  compileCoordinatedFlowFile,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import {
  capabilities,
  type Capability,
  type CompiledStep,
} from "@polymux/protocol";
import { runCoordinatedFlowInstances } from "@polymux/runner";

const mailpitBinary = process.env.POLYMUX_MAILPIT_BIN;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForMailpit(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/info`);
      if (response.ok) return;
    } catch {
      // Mailpit is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Mailpit did not become ready");
}

class SendingDriver implements Driver {
  readonly id = "mailpit-smoke.web";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.enter,
    capabilities.navigate,
  ]);
  readonly entered: string[] = [];
  readonly navigated: string[] = [];

  constructor(private readonly mailpitUrl: string) {}

  async createSession(_context: DriverSessionContext): Promise<DriverSession> {
    return {
      execute: async (step: CompiledStep) => {
        if (step.kind === "navigate") {
          this.navigated.push(String(step.input.to));
          return;
        }
        if (step.kind !== "enter") return;
        const value = String(step.input.value);
        this.entered.push(value);
        if (this.entered.length !== 1) return;
        const response = await fetch(`${this.mailpitUrl}/api/v1/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            From: { Email: "no-reply@example.test" },
            To: [{ Email: value }],
            Subject: "Verify your real Mailpit test",
            Text: "Your one-time verification code is 849205.",
            HTML: "<a href=\"https://example.test/verify?token=mailpit-secret\">Verify account</a>",
          }),
        });
        if (!response.ok) throw new Error(`Mailpit send failed with HTTP ${response.status}`);
      },
      close: async () => [],
    };
  }
}

describe.skipIf(!mailpitBinary)("real Mailpit email verification", () => {
  let processHandle: ChildProcess | undefined;
  let projectDir = "";
  let mailpitUrl = "";

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "polymux-real-mailpit-"));
    const httpPort = await availablePort();
    const smtpPort = await availablePort();
    mailpitUrl = `http://127.0.0.1:${httpPort}`;
    processHandle = spawn(mailpitBinary!, [
      "--listen", `127.0.0.1:${httpPort}`,
      "--smtp", `127.0.0.1:${smtpPort}`,
      "--database", join(projectDir, "mailpit.db"),
      "--disable-version-check",
      "--quiet",
    ], { stdio: "ignore" });
    await waitForMailpit(mailpitUrl);
  });

  afterAll(async () => {
    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill("SIGTERM");
      await new Promise<void>((resolveExit) => processHandle!.once("exit", () => resolveExit()));
    }
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it("allocates, receives, extracts, continues, and redacts against Mailpit", async () => {
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    await writeFile(join(flowDir, "actor.flow.yaml"), [
      "version: 1",
      "name: Real Mailpit actor",
      "steps:",
      "  - enter:",
      "      target: { label: Email }",
      "      value: ${fixtures.inbox.values.address}",
      "  - receiveEmail:",
      "      fixture: inbox",
      "      saveAs: verification",
      "      timeoutMs: 5000",
      "      match: { from: no-reply@example.test, subject: real Mailpit }",
      "      extract: [otp, link]",
      "  - enter:",
      "      target: { label: Code }",
      "      value: ${messages.verification.secrets.otp}",
      "  - navigate: ${messages.verification.secrets.link}",
      "",
    ].join("\n"));
    const rootFlow = join(flowDir, "verification.flow.yaml");
    await writeFile(rootFlow, [
      "version: 1",
      "name: Real Mailpit verification",
      "providers:",
      "  mail:",
      "    builtin: mailpit",
      `    config: { url: ${mailpitUrl}, pollIntervalMs: 20 }`,
      "fixtures:",
      "  inbox: { provider: mail, type: inbox }",
      "actors:",
      "  user:",
      "    flow: actor.flow.yaml",
      "    fixtures: { inbox: inbox }",
      "",
    ].join("\n"));
    const driver = new SendingDriver(mailpitUrl);
    const result = await runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(rootFlow),
      driver,
      { projectDir },
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe("passed");
    expect(driver.entered[0]).toMatch(/^polymux-[a-f0-9]{20}@mailpit\.test$/);
    expect(driver.entered[1]).toBe("849205");
    expect(driver.navigated).toEqual([
      "https://example.test/verify?token=mailpit-secret",
    ]);
    expect(JSON.stringify(result)).not.toContain("849205");
    expect(JSON.stringify(result)).not.toContain("mailpit-secret");
    expect(result.runs[0]?.actors[0]?.run.steps.map(({ status }) => status))
      .toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("verifies a real local signup application in Chromium", async () => {
    const browserProjectDir = await mkdtemp(
      join(tmpdir(), "polymux-mailpit-browser-"),
    );
    const applicationPort = await availablePort();
    const applicationUrl = `http://127.0.0.1:${applicationPort}`;
    const verificationCode = "849205";
    const verificationToken = "mailpit-browser-secret";
    const application = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", applicationUrl);
      if (request.method === "GET" && requestUrl.pathname === "/signup") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(`<!doctype html>
<title>Mailpit signup</title>
<main>
  <h1>Create account</h1>
  <form id="signup">
    <label>Email <input name="email" type="email" required></label>
    <button type="submit">Sign up</button>
  </form>
  <form id="verify">
    <label>Verification code <input name="code" inputmode="numeric" required></label>
    <button type="submit">Verify code</button>
  </form>
  <p role="status">Ready</p>
</main>
<script>
const status = document.querySelector('[role="status"]');
document.querySelector("#signup").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = new FormData(event.currentTarget).get("email");
  const result = await fetch("/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  status.textContent = result.ok ? "Check your inbox" : "Signup failed";
});
document.querySelector("#verify").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get("code");
  const result = await fetch("/api/verify-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  status.textContent = result.ok ? "Code verified" : "Invalid code";
});
</script>`);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/signup") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const input = JSON.parse(body) as { email?: unknown };
        if (
          typeof input.email !== "string"
          || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)
        ) {
          response.writeHead(400);
          response.end();
          return;
        }
        const delivery = await fetch(`${mailpitUrl}/api/v1/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            From: { Email: "no-reply@example.test" },
            To: [{ Email: input.email }],
            Subject: "Verify your browser signup",
            Text: `Your one-time verification code is ${verificationCode}.`,
            HTML:
              `<a href="${applicationUrl}/verify?token=${verificationToken}">Verify account</a>`,
          }),
        });
        response.writeHead(delivery.ok ? 201 : 502);
        response.end();
        return;
      }

      if (
        request.method === "POST"
        && requestUrl.pathname === "/api/verify-code"
      ) {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const input = JSON.parse(body) as { code?: unknown };
        response.writeHead(input.code === verificationCode ? 204 : 403);
        response.end();
        return;
      }

      if (
        request.method === "GET"
        && requestUrl.pathname === "/verify"
        && requestUrl.searchParams.get("token") === verificationToken
      ) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end("<h1>Email verified</h1>");
        return;
      }

      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolveListen) =>
      application.listen(applicationPort, "127.0.0.1", resolveListen)
    );
    try {
      const flowDir = join(browserProjectDir, "polymux");
      await mkdir(flowDir);
      await writeFile(join(flowDir, "signup.flow.yaml"), [
        "version: 1",
        "name: Browser email signup",
        "platforms: [web]",
        "steps:",
        `  - navigate: ${applicationUrl}/signup`,
        "  - enter:",
        "      target: { label: Email }",
        "      value: ${fixtures.inbox.values.address}",
        "  - activate: { role: button, name: Sign up }",
        "  - expect: { text: Check your inbox }",
        "  - receiveEmail:",
        "      fixture: inbox",
        "      saveAs: verification",
        "      timeoutMs: 5000",
        "      match: { from: no-reply@example.test, subject: browser signup }",
        "      extract: [otp, link]",
        "  - enter:",
        "      target: { label: Verification code }",
        "      value: ${messages.verification.secrets.otp}",
        "  - activate: { role: button, name: Verify code }",
        "  - expect: { text: Code verified }",
        "  - navigate: ${messages.verification.secrets.link}",
        "  - expect: { text: Email verified }",
        "",
      ].join("\n"));
      const rootFlow = join(flowDir, "verification.flow.yaml");
      await writeFile(rootFlow, [
        "version: 1",
        "name: Browser Mailpit verification",
        "providers:",
        "  mail:",
        "    builtin: mailpit",
        `    config: { url: ${mailpitUrl}, pollIntervalMs: 20 }`,
        "fixtures:",
        "  inbox: { provider: mail, type: inbox }",
        "actors:",
        "  user:",
        "    flow: signup.flow.yaml",
        "    fixtures: { inbox: inbox }",
        "",
      ].join("\n"));

      const result = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(rootFlow),
        new WebDriver({ browser: "chromium", headless: true }),
        { projectDir: browserProjectDir },
      );

      expect(result.status, JSON.stringify(result, null, 2)).toBe("passed");
      expect(JSON.stringify(result)).not.toContain(verificationCode);
      expect(JSON.stringify(result)).not.toContain(verificationToken);
      expect(result.runs[0]?.actors[0]?.run.artifacts).toEqual([]);
      expect(result.runs[0]?.actors[0]?.run.steps.map(({ status }) => status))
        .toEqual(Array.from({ length: 10 }, () => "passed"));
    } finally {
      await new Promise<void>((resolveClose) =>
        application.close(() => resolveClose())
      );
      await rm(browserProjectDir, { recursive: true, force: true });
    }
  });
});
