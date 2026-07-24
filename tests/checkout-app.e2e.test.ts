import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPolymuxTestChallenge } from "@polymux/test-gates";

const repositoryRoot = resolve(import.meta.dirname, "..");
let fixtureServer: ReturnType<typeof spawn> | undefined;
let baseUrl = "";

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

async function runCli(
  args: string[],
  cwd = repositoryRoot,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [join(repositoryRoot, "apps/cli/dist/index.js"), ...args],
      {
        cwd,
        env: { ...process.env, POLYMUX_TELEMETRY_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      resolveRun({ code: code ?? -1, stdout, stderr });
    });
  });
}

function startCli(
  args: string[],
  cwd = repositoryRoot,
): {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
} {
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, "apps/cli/dist/index.js"), ...args],
    {
      cwd,
      env: { ...process.env, POLYMUX_TELEMETRY_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  return { child, output: () => output };
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

async function stopCli(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise<number>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code ?? -1));
  });
  child.kill("SIGTERM");
  return exited;
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

beforeAll(async () => {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  fixtureServer = spawn(process.execPath, ["server.mjs"], {
    cwd: join(repositoryRoot, "tests/fixtures/checkout-app"),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("Checkout app fixture did not start")),
      5_000,
    );
    fixtureServer?.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("Checkout app fixture listening")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    fixtureServer?.once("error", rejectReady);
  });
}, 10_000);

afterAll(() => {
  fixtureServer?.kill("SIGTERM");
});

describe("polymux CLI end to end", () => {
  it.each(["chromium", "firefox", "webkit"])(
    "runs a compiled checkout flow in %s with complete evidence",
    async (browser) => {
      const output = await mkdtemp(join(tmpdir(), "polymux-e2e-runs-"));
      const result = await runCli([
        "run",
        "paid-order",
        "--project-dir",
        "tests/fixtures/checkout-app",
        "--url",
        baseUrl,
        "--browser",
        browser,
        "--output",
        output,
        "-j",
      ]);

      expect(result.code).toBe(0);
      const batch = JSON.parse(result.stdout);
      expect(batch.status).toBe("passed");
      expect(batch.runs[0]).toMatchObject({
        flow: "Checkout creates a paid order",
        status: "passed",
        artifacts: ["trace.zip"],
      });
      expect(batch.runs[0].steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "request",
            status: "passed",
          }),
          expect.objectContaining({
            kind: "screenshot",
            artifacts: ["screenshots/checkout-confirmed.png"],
          }),
        ]),
      );
    },
    20_000,
  );

  it(
    "runs coordinated actors in isolated browser sessions",
    async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-flow-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(join(projectDir, "polymux/buyer.flow.yaml"), `version: 1
name: Buyer
platforms: [web]
steps:
  - navigate: ${baseUrl}/checkout
  - expect: { text: Checkout }
  - signal: checkout-opened
  - waitForSignal: seller-ready
  - expect: { text: Checkout }
`);
      await writeFile(join(projectDir, "polymux/seller.flow.yaml"), `version: 1
name: Seller
platforms: [web]
steps:
  - waitForSignal: checkout-opened
  - navigate: ${baseUrl}/checkout
  - expect: { text: Checkout }
  - signal: seller-ready
`);
      await writeFile(join(projectDir, "polymux/purchase.flow.yaml"), `version: 1
name: Coordinated purchase
actors:
  buyer: buyer.flow.yaml
  seller: seller.flow.yaml
`);

      const result = await runCli([
        "run",
        "purchase",
        "--project-dir",
        projectDir,
        "--repeat",
        "2",
        "--json",
      ]);

      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      const batch = JSON.parse(result.stdout);
      expect(batch.status).toBe("passed");
      expect(batch.runs).toHaveLength(2);
      expect(batch.runs[0].actors.map(({ actor }: { actor: string }) => actor))
        .toEqual(["buyer", "seller"]);
      expect(batch.runs[0].actors[0].run).toMatchObject({
        actor: "buyer",
        flowRunId: batch.runs[0].flowRunId,
        status: "passed",
      });
      await expect(access(join(batch.runs[0].artifactsDir, "results.json")))
        .resolves.toBeUndefined();
      await expect(access(join(batch.runs[0].artifactsDir, "report.html")))
        .resolves.toBeUndefined();

      const all = await runCli([
        "run",
        "--project-dir",
        projectDir,
        "--json",
      ]);
      expect(all.code, `${all.stderr}\n${all.stdout}`).toBe(0);
      const allBatch = JSON.parse(all.stdout);
      expect(allBatch.runs).toHaveLength(1);
      expect(allBatch.runs[0]).toMatchObject({
        flow: "Coordinated purchase",
        status: "passed",
      });
    },
    20_000,
  );

  it(
    "passes a signed test challenge through a real browser to a server verifier",
    async () => {
      const secret = "browser-challenge-secret-with-thirty-two-characters";
      const consumedChallenges = new Set<string>();
      const challengeServer = createServer(async (request, response) => {
        response.setHeader("content-type", "text/html");
        if (request.url === "/public") {
          response.end("<h1>Public observer</h1>");
          return;
        }
        try {
          await verifyPolymuxTestChallenge(String(request.headers["x-polymux-test-assertion"] ?? ""), {
            secret,
            audience: "challenge-e2e",
            action: "submit-order",
            environment: "test",
            consumeJti: (jti) => {
              if (consumedChallenges.has(jti)) return false;
              consumedChallenges.add(jti);
              return true;
            },
          });
          response.end("<h1>Challenge accepted</h1>");
        } catch {
          response.writeHead(403);
          response.end("<h1>Challenge rejected</h1>");
        }
      });
      await new Promise<void>((resolveListen) => challengeServer.listen(0, "127.0.0.1", resolveListen));
      const address = challengeServer.address();
      if (!address || typeof address === "string") throw new Error("No challenge server port");
      const url = `http://127.0.0.1:${address.port}`;
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-challenge-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(join(projectDir, "polymux/buyer.flow.yaml"), `version: 1
name: Challenge buyer
steps:
  - navigate: ${url}/protected
  - expect: { text: Challenge accepted }
`);
      await writeFile(join(projectDir, "polymux/observer.flow.yaml"), `version: 1
name: Challenge observer
steps:
  - navigate: ${url}/public
  - expect: { text: Public observer }
`);
      await writeFile(join(projectDir, "polymux/challenge.flow.yaml"), `version: 1
name: Browser challenge
providers:
  testGate: { builtin: challenge }
fixtures:
  captcha:
    provider: testGate
    type: challenge
    input: { audience: challenge-e2e, action: submit-order, ttlSeconds: 60 }
actors:
  buyer:
    flow: buyer.flow.yaml
    fixtures: { challenge: captcha }
    headers:
      x-polymux-test-assertion: \${fixtures.challenge.secrets.assertion}
  observer: observer.flow.yaml
`);
      const previousSecret = process.env.POLYMUX_TEST_CHALLENGE_SECRET;
      const previousEnvironment = process.env.POLYMUX_TEST_ENVIRONMENT;
      process.env.POLYMUX_TEST_CHALLENGE_SECRET = secret;
      process.env.POLYMUX_TEST_ENVIRONMENT = "test";
      try {
        const result = await runCli([
          "run",
          "challenge",
          "--project-dir",
          projectDir,
          "--json",
        ]);
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
        const batch = JSON.parse(result.stdout);
        expect(batch.status).toBe("passed");
        expect(batch.runs[0].fixtures).toEqual([
          { name: "captcha", provider: "testGate", type: "challenge", status: "cleaned" },
        ]);
        expect(JSON.stringify(batch)).not.toContain("eyJhbGciOiJIUzI1NiI");
      } finally {
        if (previousSecret === undefined) delete process.env.POLYMUX_TEST_CHALLENGE_SECRET;
        else process.env.POLYMUX_TEST_CHALLENGE_SECRET = previousSecret;
        if (previousEnvironment === undefined) delete process.env.POLYMUX_TEST_ENVIRONMENT;
        else process.env.POLYMUX_TEST_ENVIRONMENT = previousEnvironment;
        await new Promise<void>((resolveClose) => challengeServer.close(() => resolveClose()));
      }
    },
    20_000,
  );

  it(
    "bootstraps an application session without visiting the hosted OAuth provider",
    async () => {
      const secret = "oauth-session-secret-with-at-least-thirty-two-characters";
      const sessionCookie = "polymux-oauth-session";
      const consumedAssertions = new Set<string>();
      const receivedAssertions: string[] = [];
      const protectedCookies: string[] = [];
      let applicationEnvironment = "test";
      let successfulBootstraps = 0;

      const authServer = createServer(async (request, response) => {
        if (
          request.method === "POST" &&
          request.url === "/__test/auth/session"
        ) {
          if (applicationEnvironment !== "test") {
            response.writeHead(404);
            response.end();
            return;
          }
          const assertion = String(
            request.headers["x-polymux-test-assertion"] ?? "",
          );
          try {
            await verifyPolymuxTestChallenge(assertion, {
              secret,
              audience: "oauth-session-e2e",
              action: "bootstrap-session",
              environment: "test",
              consumeJti: (jti) => {
                if (consumedAssertions.has(jti)) return false;
                consumedAssertions.add(jti);
                return true;
              },
            });
          } catch {
            response.writeHead(403);
            response.end();
            return;
          }
          receivedAssertions.push(assertion);
          successfulBootstraps += 1;
          response.writeHead(204, {
            "set-cookie": `polymux_session=${sessionCookie}; HttpOnly; SameSite=Lax; Path=/`,
          });
          response.end();
          return;
        }

        if (request.method === "GET" && request.url === "/private") {
          const cookie = String(request.headers.cookie ?? "");
          protectedCookies.push(cookie);
          if (!cookie.split(";").map((part) => part.trim()).includes(
            `polymux_session=${sessionCookie}`,
          )) {
            response.writeHead(401, { "content-type": "text/html" });
            response.end("<h1>Sign in required</h1>");
            return;
          }
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<!doctype html>
<title>Protected account</title>
<h1>OAuth session active</h1>
<button type="button" id="continue">Continue</button>
<p id="result">Waiting</p>
<script>
document.querySelector("#continue").addEventListener("click", () => {
  document.querySelector("#result").textContent = "Session interaction complete";
});
</script>`);
          return;
        }

        response.writeHead(404);
        response.end();
      });
      await new Promise<void>((resolveListen) =>
        authServer.listen(0, "127.0.0.1", resolveListen),
      );
      const address = authServer.address();
      if (!address || typeof address === "string") {
        throw new Error("No OAuth session server port");
      }
      const url = `http://127.0.0.1:${address.port}`;
      const projectDir = await mkdtemp(
        join(tmpdir(), "polymux-e2e-oauth-session-"),
      );
      await mkdir(join(projectDir, "polymux"));
      await writeFile(
        join(projectDir, "polymux/browser.flow.yaml"),
        `version: 1
name: Authenticated browser
platforms: [web]
steps:
  - request:
      method: POST
      url: ${url}/__test/auth/session
      headers:
        x-polymux-test-assertion: \${fixtures.session.secrets.assertion}
      expect: { status: 204 }
  - navigate: ${url}/private
  - expect: { text: OAuth session active }
  - activate: { role: button, name: Continue }
  - expect: { text: Session interaction complete }
  - screenshot: { name: oauth-session-active }
`,
      );
      await writeFile(
        join(projectDir, "polymux/oauth-session.flow.yaml"),
        `version: 1
name: OAuth session bootstrap
providers:
  testGate: { builtin: challenge }
fixtures:
  oauthSession:
    provider: testGate
    type: challenge
    input:
      audience: oauth-session-e2e
      action: bootstrap-session
      ttlSeconds: 60
actors:
  browser:
    flow: browser.flow.yaml
    fixtures: { session: oauthSession }
`,
      );

      const previousSecret = process.env.POLYMUX_TEST_CHALLENGE_SECRET;
      const previousEnvironment = process.env.POLYMUX_TEST_ENVIRONMENT;
      process.env.POLYMUX_TEST_CHALLENGE_SECRET = secret;
      process.env.POLYMUX_TEST_ENVIRONMENT = "test";
      try {
        const result = await runCli([
          "run",
          "oauth-session",
          "--project-dir",
          projectDir,
          "--browser",
          "chromium",
          "--json",
        ]);
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
        const batch = JSON.parse(result.stdout);
        expect(batch.status).toBe("passed");
        expect(batch.runs[0].actors[0].run).toMatchObject({
          flow: "Authenticated browser",
          status: "passed",
          artifacts: [],
        });
        await expect(
          access(join(batch.runs[0].actors[0].run.artifactsDir, "trace.zip")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(batch.runs[0].actors[0].run.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "screenshot",
              artifacts: ["screenshots/oauth-session-active.png"],
            }),
          ]),
        );
        expect(successfulBootstraps).toBe(1);
        expect(receivedAssertions).toHaveLength(1);
        expect(protectedCookies).toEqual([
          expect.stringContaining(`polymux_session=${sessionCookie}`),
        ]);
        expect(JSON.stringify(batch)).not.toContain(receivedAssertions[0]);

        const replay = await fetch(`${url}/__test/auth/session`, {
          method: "POST",
          headers: {
            "x-polymux-test-assertion": receivedAssertions[0]!,
          },
        });
        expect(replay.status).toBe(403);
        expect(replay.headers.get("set-cookie")).toBeNull();
        expect(successfulBootstraps).toBe(1);

        applicationEnvironment = "production";
        const production = await fetch(`${url}/__test/auth/session`, {
          method: "POST",
          headers: {
            "x-polymux-test-assertion": receivedAssertions[0]!,
          },
        });
        expect(production.status).toBe(404);
        expect(production.headers.get("set-cookie")).toBeNull();
        expect(successfulBootstraps).toBe(1);
      } finally {
        if (previousSecret === undefined) {
          delete process.env.POLYMUX_TEST_CHALLENGE_SECRET;
        } else {
          process.env.POLYMUX_TEST_CHALLENGE_SECRET = previousSecret;
        }
        if (previousEnvironment === undefined) {
          delete process.env.POLYMUX_TEST_ENVIRONMENT;
        } else {
          process.env.POLYMUX_TEST_ENVIRONMENT = previousEnvironment;
        }
        await new Promise<void>((resolveClose) =>
          authServer.close(() => resolveClose()),
        );
      }
    },
    20_000,
  );

  it(
    "limits temporary protection credentials to the configured origin",
    async () => {
      const externalHeaders: Array<string | undefined> = [];
      const protectedHeaders: Array<string | undefined> = [];
      const externalServer = createServer((request, response) => {
        externalHeaders.push(request.headers["x-vendor-test"] as string | undefined);
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader("content-type", "text/plain");
        response.end("external response");
      });
      await new Promise<void>((resolveListen) =>
        externalServer.listen(0, "127.0.0.1", resolveListen),
      );
      const externalAddress = externalServer.address();
      if (!externalAddress || typeof externalAddress === "string") {
        throw new Error("No external server port");
      }
      const externalUrl = `http://127.0.0.1:${externalAddress.port}`;
      const protectedServer = createServer((request, response) => {
        protectedHeaders.push(request.headers["x-vendor-test"] as string | undefined);
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html>
<h1 id="status">Loading protection test</h1>
<script>
fetch(${JSON.stringify(`${externalUrl}/resource`)})
  .then(() => { document.querySelector("#status").textContent = "External loaded"; })
  .catch(() => { document.querySelector("#status").textContent = "External failed"; });
</script>`);
      });
      await new Promise<void>((resolveListen) =>
        protectedServer.listen(0, "127.0.0.1", resolveListen),
      );
      const protectedAddress = protectedServer.address();
      if (!protectedAddress || typeof protectedAddress === "string") {
        throw new Error("No protected server port");
      }
      const protectedUrl = `http://127.0.0.1:${protectedAddress.port}`;

      try {
        const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-protection-"));
        await mkdir(join(projectDir, "polymux"));
        for (const actor of ["buyer", "seller"]) {
          await writeFile(join(projectDir, `polymux/${actor}.flow.yaml`), `version: 1
name: Protected ${actor}
steps:
  - navigate: \${protections.edge.values.origin}
  - expect: { text: External loaded }
`);
        }
        await writeFile(join(projectDir, "polymux/protected.flow.yaml"), `version: 1
name: Scoped browser protection
actors:
  buyer: buyer.flow.yaml
  seller: seller.flow.yaml
`);
        const initialized = await runCli([
          "access",
          "init",
          "--project-dir",
          projectDir,
          "--flow",
          "protected",
          "--origin",
          protectedUrl,
          "--environment",
          "test",
          "--name",
          "edge",
          "--header",
          "x-vendor-test",
          "--token-env",
          "POLYMUX_E2E_PROTECTION_TOKEN",
          "--json",
        ]);
        expect(initialized.code, `${initialized.stderr}\n${initialized.stdout}`).toBe(0);
        const protectionSecret = JSON.parse(initialized.stdout).token as string;
        const result = await runCli([
          "run",
          "protected",
          "--project-dir",
          projectDir,
          "--json",
        ]);
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
        const batch = JSON.parse(result.stdout);
        expect(batch.status).toBe("passed");
        expect(batch.runs[0].protections).toEqual([
          { name: "edge", status: "configured" },
        ]);
        expect(protectedHeaders.length).toBeGreaterThanOrEqual(2);
        expect(protectedHeaders.every((value) => value === protectionSecret)).toBe(true);
        expect(externalHeaders.length).toBeGreaterThanOrEqual(2);
        expect(externalHeaders.every((value) => value === undefined)).toBe(true);
        expect(JSON.stringify(batch)).not.toContain(protectionSecret);
      } finally {
        await Promise.all([
          new Promise<void>((resolveClose) =>
            protectedServer.close(() => resolveClose()),
          ),
          new Promise<void>((resolveClose) =>
            externalServer.close(() => resolveClose()),
          ),
        ]);
      }
    },
    20_000,
  );

  it(
    "applies deterministic network mocks and records device-profile video",
    async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-web-options-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(
        join(projectDir, "polymux/mocked-config.flow.yaml"),
        `version: 1
name: Mocked configuration
platforms: [web]
steps:
  - mock:
      url: "**/api/config"
      response:
        json:
          experimental: true
  - navigate: ${baseUrl}/checkout
  - expect:
      text: Experimental mode
  - unmock: "**/api/config"
`,
      );
      const result = await runCli([
        "run",
        "mocked-config",
        "--project-dir",
        projectDir,
        "--device",
        "iPhone 13",
        "--video",
        "--json",
      ]);

      expect(result.code).toBe(0);
      const batch = JSON.parse(result.stdout);
      expect(batch.status).toBe("passed");
      expect(batch.runs[0].artifacts).toEqual(
        expect.arrayContaining([
          "trace.zip",
          expect.stringMatching(/^videos\/.+\.webm$/),
        ]),
      );
    },
    20_000,
  );

  it.each(["chromium", "firefox", "webkit"])(
    "executes the complete portable web interaction surface in %s",
    async (browser) => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-interactions-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(join(projectDir, "polymux/interactions.flow.yaml"), `version: 1
name: Complete web interactions
platforms: [web]
baseUrl: ${baseUrl}
steps:
  - launch: { clearState: true }
  - deepLink: /checkout
  - focus: { role: button, name: "Pay now later", exact: true }
  - key: Enter
  - expect: { target: { id: interaction-result }, text: Deferred payment }
  - select:
      target: { label: Country }
      value: Singapore
  - expect: { target: { id: interaction-result }, text: Selected Singapore }
  - activate: { id: styled-radio }
  - expect: { target: { id: database-result }, text: SQLite selected }
  - activate: { id: styled-checkbox }
  - expect: { target: { id: checkbox-result }, text: Database remembered }
  - enter: { target: { label: Notes }, value: temporary }
  - clear: { label: Notes }
  - expect: { target: { label: Notes }, value: "" }
  - key: Enter
  - expect: { target: { id: interaction-result }, text: Pressed Enter }
  - pointer: { x: 10, y: 10 }
  - expect: { target: { id: interaction-result }, text: Pointer activated }
  - scroll: { target: { id: scroll-area }, y: 150 }
  - expect: { target: { id: interaction-result }, text: Scrolled content }
  - swipe: { target: { id: swipe-pad }, direction: right, distance: 80 }
  - expect: { target: { id: interaction-result }, text: Swiped right }
  - drag: { from: { id: drag-source }, to: { id: drop-target } }
  - expect: { target: { id: interaction-result }, text: Dropped card }
  - wait: { target: { id: drop-target }, state: attached }
  - expect: { target: { label: Country }, state: enabled }
  - expect: { target: { id: disabled-control }, state: disabled }
  - expect: { target: { css: '.count-item' }, count: 2 }
  - screenshot: { name: interaction-result, target: { id: interaction-result } }
  - clock: { action: install }
  - clock: { action: pause, ms: 1893456000000 }
  - clock: { action: advance, ms: 100 }
  - clock: { action: resume }
`);
      const result = await runCli(["run", "interactions", "--project-dir", projectDir, "--browser", browser, "--json"]);
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      const batch = JSON.parse(result.stdout);
      expect(batch.status).toBe("passed");
      expect(batch.runs[0].steps).toHaveLength(33);
    },
    20_000,
  );

  it(
    "dispatches deterministic Chromium multi-touch gestures",
    async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-touch-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(
        join(projectDir, "polymux/multi-touch.flow.yaml"),
        `version: 1
name: Multi-touch gesture
platforms: [web]
steps:
  - navigate: ${baseUrl}/checkout
  - multiTouch:
      gesture: tap
      points:
        - { x: 120, y: 180 }
        - { x: 180, y: 180 }
  - expect:
      text: 2 touches
`,
      );
      const result = await runCli([
        "run",
        "multi-touch",
        "--project-dir",
        projectDir,
        "--json",
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("passed");
    },
    20_000,
  );

  it(
    "locates and activates a deterministic image target",
    async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-image-"));
      await mkdir(join(projectDir, "polymux"));
      const target = new PNG({ width: 12, height: 12 });
      for (let offset = 0; offset < target.data.length; offset += 4) {
        target.data[offset] = 225;
        target.data[offset + 1] = 29;
        target.data[offset + 2] = 72;
        target.data[offset + 3] = 255;
      }
      await writeFile(
        join(projectDir, "polymux/image-target.png"),
        PNG.sync.write(target),
      );
      await writeFile(
        join(projectDir, "polymux/image-target.flow.yaml"),
        `version: 1
name: Image target
platforms: [web]
steps:
  - navigate: ${baseUrl}/checkout
  - activate:
      image: image-target.png
  - expect:
      text: Image activated
`,
      );
      const result = await runCli([
        "run",
        "image-target",
        "--project-dir",
        projectDir,
        "--json",
      ]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe("passed");
    },
    20_000,
  );

  it(
    "uses conventional exit codes for assertion and configuration failures",
    async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-fail-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(
        join(projectDir, "polymux/failure.flow.yaml"),
        `version: 1
name: Expected failure
platforms: [web]
timeoutMs: 250
steps:
  - navigate: ${baseUrl}/checkout
  - expect:
      text: This text does not exist
`,
      );
      const failed = await runCli([
        "run",
        "--project-dir",
        projectDir,
        "--json",
      ]);
      expect(failed.code).toBe(1);
      expect(JSON.parse(failed.stdout).status).toBe("failed");

      await writeFile(
        join(projectDir, "polymux/invalid.flow.yaml"),
        "name: Invalid\nsteps: []\n",
      );
      const invalid = await runCli([
        "build",
        "invalid",
        "--project-dir",
        projectDir,
      ]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("Invalid flow");

      const invalidJson = await runCli([
        "run",
        "invalid",
        "--project-dir",
        projectDir,
        "--json",
      ]);
      expect(invalidJson.code).toBe(2);
      expect(JSON.parse(invalidJson.stdout)).toMatchObject({
        status: "error",
        runs: [],
        error: { name: "FlowCompileError" },
      });
    },
    20_000,
  );

  it(
    "creates and reuses deterministic visual baselines",
    async () => {
      const projectDir = await mkdtemp(join(tmpdir(), "polymux-e2e-visual-"));
      await mkdir(join(projectDir, "polymux"));
      await writeFile(
        join(projectDir, "polymux/visual.flow.yaml"),
        `version: 1
name: Checkout visual
platforms: [web]
steps:
  - navigate: ${baseUrl}/checkout
  - stabilize:
      timeoutMs: 2000
  - visual:
      name: checkout-page
      threshold: 0
`,
      );
      const update = await runCli([
        "run",
        "--project-dir",
        projectDir,
        "--update-snapshots",
        "--json",
      ]);
      expect(update.code).toBe(0);
      await expect(
        access(
          join(
            projectDir,
            "polymux/__snapshots__/checkout-visual/checkout-page.png",
          ),
        ),
      ).resolves.toBeUndefined();

      const compare = await runCli([
        "run",
        "--project-dir",
        projectDir,
        "--json",
      ]);
      expect(compare.code).toBe(0);
      expect(JSON.parse(compare.stdout).runs[0].steps.at(-1)).toMatchObject({
        kind: "visual",
        status: "passed",
        message: "Visual difference 0.00%",
      });
    },
    20_000,
  );

  it(
    "reruns in watch mode and exits cleanly on termination",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "polymux-e2e-watch-"));
      const projectDir = join(root, "checkout-app");
      const output = join(root, "runs");
      await cp(join(repositoryRoot, "tests/fixtures/checkout-app"), projectDir, {
        recursive: true,
      });
      const running = startCli([
        "run",
        "paid-order",
        "--project-dir",
        projectDir,
        "--url",
        baseUrl,
        "--output",
        output,
        "--quiet",
        "--watch",
      ]);

      try {
        await waitUntil(
          () => running.output().includes("Watching Polymux flows"),
          10_000,
          `Watch mode did not start:\n${running.output()}`,
        );
        const flowPath = join(projectDir, "polymux/paid-order.flow.yaml");
        const flow = await readFile(flowPath, "utf8");
        await writeFile(flowPath, `${flow}\n# trigger watch rerun\n`);
        await waitUntil(
          () => occurrences(running.output(), "1 passed, 0 failed, 0 errors") >= 2,
          10_000,
          `Watch mode did not rerun:\n${running.output()}`,
        );
      } finally {
        expect(await stopCli(running.child)).toBe(143);
      }
    },
    20_000,
  );

  it(
    "owns the development server lifecycle and reruns after source changes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "polymux-e2e-dev-"));
      const projectDir = join(root, "checkout-app");
      const output = join(root, "runs");
      const port = await availablePort();
      const devUrl = `http://127.0.0.1:${port}`;
      await cp(join(repositoryRoot, "tests/fixtures/checkout-app"), projectDir, {
        recursive: true,
      });
      const running = startCli([
        "dev",
        "paid-order",
        "--project-dir",
        projectDir,
        "--url",
        devUrl,
        "--command",
        `PORT=${port} node server.mjs`,
        "--output",
        output,
        "--debounce-ms",
        "50",
        "--wait-ms",
        "5000",
        "--quiet",
      ]);

      try {
        await waitUntil(
          () => running.output().includes("Watching application and flow changes"),
          10_000,
          `Development mode did not start:\n${running.output()}`,
        );
        const sourcePath = join(projectDir, "server.mjs");
        const source = await readFile(sourcePath, "utf8");
        await writeFile(sourcePath, `${source}\n// trigger development rerun\n`);
        await waitUntil(
          () => occurrences(running.output(), "1 passed, 0 failed, 0 errors") >= 2,
          10_000,
          `Development mode did not rerun:\n${running.output()}`,
        );
      } finally {
        expect(await stopCli(running.child)).toBe(143);
      }

      await waitUntil(
        async () => {
          try {
            await fetch(devUrl, { signal: AbortSignal.timeout(250) });
            return false;
          } catch {
            return true;
          }
        },
        5_000,
        "The development server was left running after Polymux stopped",
      );
    },
    25_000,
  );

  it(
    "reports a development server that exits before becoming ready",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "polymux-e2e-dev-fail-"));
      const projectDir = join(root, "checkout-app");
      const port = await availablePort();
      await cp(join(repositoryRoot, "tests/fixtures/checkout-app"), projectDir, {
        recursive: true,
      });

      const result = await runCli([
        "dev",
        "paid-order",
        "--project-dir",
        projectDir,
        "--url",
        `http://127.0.0.1:${port}`,
        "--command",
        `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
        "--wait-ms",
        "2000",
      ]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("development server exited with code 7");
    },
    10_000,
  );
});
