import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileCoordinatedFlowFile,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import { capabilities, type Capability, type CompiledStep, type RunEvent } from "@polymux/protocol";
import { runCoordinatedFlowInstances } from "@polymux/runner";
import { verifyPolymuxTestChallenge } from "@polymux/test-gates";

class FixtureDriver implements Driver {
  readonly id = "fixture.web";
  readonly platform = "web" as const;
  readonly supportsScopedHeaders = true;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.navigate,
    capabilities.enter,
  ]);
  readonly steps: Array<{ flow: string; step: CompiledStep }> = [];
  readonly headers = new Map<string, Record<string, string>>();
  readonly scopedHeaders = new Map<string, DriverSessionContext["scopedHeaders"]>();
  readonly containsSecrets = new Map<string, boolean>();

  async createSession(context: DriverSessionContext): Promise<DriverSession> {
    this.headers.set(context.plan.name, context.headers ?? {});
    this.scopedHeaders.set(context.plan.name, context.scopedHeaders);
    this.containsSecrets.set(context.plan.name, context.containsSecrets);
    return {
      execute: async (step) => {
        this.steps.push({ flow: context.plan.name, step });
      },
      close: async () => [],
    };
  }
}

async function writeActors(directory: string): Promise<void> {
  await writeFile(join(directory, "buyer.flow.yaml"), [
    "version: 1",
    "name: Buyer fixture flow",
    "steps:",
    "  - enter:",
    "      target: { label: Email }",
    "      value: ${fixtures.account.values.email}",
    "  - enter:",
    "      target: { label: Password }",
    "      value: ${fixtures.account.secrets.password}",
    "",
  ].join("\n"));
  await writeFile(join(directory, "observer.flow.yaml"), [
    "version: 1",
    "name: Observer",
    "steps:",
    "  - navigate: https://example.com",
    "",
  ].join("\n"));
}

describe("language-neutral fixture providers", () => {
  it("rejects unbound and non-inbox receiveEmail fixture aliases during compilation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-email-binding-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "actor.flow.yaml"), [
      "version: 1",
      "name: Email actor",
      "steps:",
      "  - receiveEmail: { fixture: inbox, saveAs: verification, extract: otp }",
      "",
    ].join("\n"));
    const parentPath = join(directory, "parent.flow.yaml");
    await writeFile(parentPath, [
      "version: 1",
      "name: Missing inbox binding",
      "actors:",
      "  user: actor.flow.yaml",
      "",
    ].join("\n"));
    await expect(compileCoordinatedFlowFile(parentPath))
      .rejects.toThrow('receiveEmail references unbound fixture alias "inbox"');

    await writeFile(parentPath, [
      "version: 1",
      "name: Wrong inbox binding",
      "providers:",
      "  app:",
      "    http: { url: https://example.test/fixtures }",
      "fixtures:",
      "  account: { provider: app, type: account }",
      "actors:",
      "  user:",
      "    flow: actor.flow.yaml",
      "    fixtures: { inbox: account }",
      "",
    ].join("\n"));
    await expect(compileCoordinatedFlowFile(parentPath))
      .rejects.toThrow('receiveEmail fixture alias "inbox" must reference an inbox');
  });

  it("rejects unbound and non-phone receiveSms fixture aliases during compilation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-sms-binding-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "actor.flow.yaml"), [
      "version: 1",
      "name: SMS actor",
      "steps:",
      "  - receiveSms: { fixture: phone, saveAs: verification, extract: otp }",
      "",
    ].join("\n"));
    const parentPath = join(directory, "parent.flow.yaml");
    await writeFile(parentPath, [
      "version: 1",
      "name: Missing phone binding",
      "actors:",
      "  user: actor.flow.yaml",
      "",
    ].join("\n"));
    await expect(compileCoordinatedFlowFile(parentPath))
      .rejects.toThrow('receiveSms references unbound fixture alias "phone"');

    await writeFile(parentPath, [
      "version: 1",
      "name: Wrong phone binding",
      "providers:",
      "  app:",
      "    http: { url: https://example.test/fixtures }",
      "fixtures:",
      "  account: { provider: app, type: account }",
      "actors:",
      "  user:",
      "    flow: actor.flow.yaml",
      "    fixtures: { phone: account }",
      "",
    ].join("\n"));
    await expect(compileCoordinatedFlowFile(parentPath))
      .rejects.toThrow('receiveSms fixture alias "phone" must reference a phone');
  });

  it("runs a JSON-lines command provider, injects actor data, and cleans up", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-fixture-command-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeActors(directory);
    const logPath = join(projectDir, "provider.log");
    const providerPath = join(projectDir, "provider.mjs");
    await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.POLYMUX_FIXTURE_TEST_LOG, request.method + ":" + (request.fixture ?? "-") + "\\n");
  const response = request.method === "create"
    ? { protocol: request.protocol, id: request.id, ok: true, result: {
        handle: "account-1",
        values: { email: "buyer-" + request.context.seed + "@test.local" },
        secrets: { password: "fixture-password" },
        auth: { token: "fixture-token" }
      } }
    : { protocol: request.protocol, id: request.id, ok: true };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`);
    const flowPath = join(directory, "accounts.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Automatic accounts",
      "providers:",
      "  app:",
      `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(providerPath)}]`,
      "fixtures:",
      "  buyerAccount:",
      "    provider: app",
      "    type: account",
      "actors:",
      "  buyer:",
      "    flow: buyer.flow.yaml",
      "    fixtures:",
      "      account: buyerAccount",
      "    headers:",
      "      x-test-auth: ${fixtures.account.auth.token}",
      "  observer: observer.flow.yaml",
      "",
    ].join("\n"));
    const previous = process.env.POLYMUX_FIXTURE_TEST_LOG;
    process.env.POLYMUX_FIXTURE_TEST_LOG = logPath;
    try {
      const driver = new FixtureDriver();
      const events: RunEvent[] = [];
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir, onEvent: (event) => events.push(event) },
      );

      expect(batch.status).toBe("passed");
      expect(batch.runs[0]?.fixtures).toEqual([
        { name: "buyerAccount", provider: "app", type: "account", status: "cleaned" },
      ]);
      const entered = driver.steps
        .filter(({ flow }) => flow === "Buyer fixture flow")
        .map(({ step }) => step.input.value);
      expect(entered[0]).toMatch(/^buyer-[a-f0-9]{24}@test\.local$/);
      expect(entered[1]).toBe("fixture-password");
      expect(driver.headers.get("Buyer fixture flow")).toEqual({
        "x-test-auth": "fixture-token",
      });
      expect(await readFile(logPath, "utf8")).toBe(
        "health:-\ncreate:buyerAccount\ndestroy:buyerAccount\n",
      );
      const serialized = JSON.stringify(batch);
      expect(serialized).not.toContain("fixture-password");
      expect(serialized).not.toContain("fixture-token");
      expect(JSON.stringify(events)).not.toContain("fixture-password");
      expect(JSON.stringify(events)).not.toContain("fixture-token");
      await expect(runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        new FixtureDriver(),
        {
          projectDir,
          executionMode: "cloud",
          fixtureEnvironment: { POLYMUX_FIXTURE_TEST_LOG: logPath },
        },
      )).rejects.toThrow('Cloud execution does not allow command fixture provider "app"');
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_FIXTURE_TEST_LOG;
      else process.env.POLYMUX_FIXTURE_TEST_LOG = previous;
    }
  });

  it("locks cloud providers to server-assigned endpoints and credentials", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-cloud-fixture-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeActors(directory);

    const supabaseFlow = join(directory, "supabase.flow.yaml");
    await writeFile(supabaseFlow, [
      "version: 1",
      "name: Cloud Supabase fixture",
      "providers:",
      "  accounts:",
      "    builtin: supabase",
      "    config:",
      "      url: https://attacker.example",
      "      serviceRoleKeyFromEnv: ATTACKER_SELECTED_SECRET",
      "fixtures:",
      "  buyerAccount: { provider: accounts, type: account }",
      "actors:",
      "  buyer:",
      "    flow: buyer.flow.yaml",
      "    fixtures: { account: buyerAccount }",
      "",
    ].join("\n"));

    await expect(runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(supabaseFlow),
      new FixtureDriver(),
      {
        projectDir,
        executionMode: "cloud",
        fixtureEnvironment: {
          SUPABASE_URL: "https://tenant.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "server-assigned-secret",
        },
      },
    )).rejects.toThrow(/Cloud execution does not allow config\./);

    const firebaseFlow = join(directory, "firebase.flow.yaml");
    await writeFile(firebaseFlow, [
      "version: 1",
      "name: Cloud Firebase fixture",
      "providers:",
      "  accounts: { builtin: firebase }",
      "fixtures:",
      "  buyerAccount: { provider: accounts, type: account }",
      "actors:",
      "  buyer:",
      "    flow: buyer.flow.yaml",
      "    fixtures: { account: buyerAccount }",
      "",
    ].join("\n"));

    await expect(runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(firebaseFlow),
      new FixtureDriver(),
      {
        projectDir,
        executionMode: "cloud",
        fixtureEnvironment: {},
      },
    )).rejects.toThrow(
      "Cloud execution requires an explicit per-run Firebase service account",
    );

    await writeFile(join(directory, "sms.flow.yaml"), [
      "version: 1",
      "name: SMS actor",
      "steps:",
      "  - navigate: https://example.test",
      "",
    ].join("\n"));
    const twilioFlow = join(directory, "twilio.flow.yaml");
    await writeFile(twilioFlow, [
      "version: 1",
      "name: Cloud Twilio fixture",
      "providers:",
      "  sms: { builtin: twilio }",
      "fixtures:",
      "  projectPhone: { provider: sms, type: phone }",
      "actors:",
      "  user:",
      "    flow: sms.flow.yaml",
      "    fixtures: { phone: projectPhone }",
      "",
    ].join("\n"));

    await expect(runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(twilioFlow),
      new FixtureDriver(),
      {
        projectDir,
        executionMode: "cloud",
        fixtureEnvironment: {},
      },
    )).rejects.toThrow(
      'Cloud execution does not allow twilio fixture provider "sms"',
    );
  });

  it("receives email mid-flow, extracts secrets, continues, and redacts evidence", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-fixture-email-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "signup.flow.yaml"), [
      "version: 1",
      "name: Verified signup",
      "steps:",
      "  - enter:",
      "      target: { label: Email }",
      "      value: ${fixtures.inbox.values.address}",
      "  - receiveEmail:",
      "      fixture: inbox",
      "      saveAs: verification",
      "      timeoutMs: 2000",
      "      match:",
      "        from: no-reply@example.test",
      "        subject: Verify your account",
      "      extract: [otp, link]",
      "  - enter:",
      "      target: { label: Verification code }",
      "      value: ${messages.verification.secrets.otp}",
      "  - navigate: ${messages.verification.secrets.link}",
      "",
    ].join("\n"));
    const logPath = join(projectDir, "mail-provider.log");
    const providerPath = join(projectDir, "mail-provider.mjs");
    await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.POLYMUX_FIXTURE_MAIL_LOG, request.method + ":" + (request.timeoutMs ?? "-") + "\\n");
  let response = { protocol: request.protocol, id: request.id, ok: true };
  if (request.method === "create") response.result = {
    handle: "inbox-1",
    values: { address: "signup-1@example.test" }
  };
  if (request.method === "receive") response.result = {
    handle: request.handle,
    values: {
      id: "message-1",
      from: "no-reply@example.test",
      subject: "Verify your account",
      receivedAt: "2026-07-23T12:00:00.000Z"
    },
    secrets: {
      text: "Your one-time verification code is 482913. Verify: https://example.test/verify?token=private-token",
      html: "<a href=\\"https://example.test/verify?token=private-token\\">Verify account</a>"
    }
  };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`);
    const flowPath = join(directory, "signup-with-email.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Signup with email verification",
      "providers:",
      "  mail:",
      `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(providerPath)}]`,
      "fixtures:",
      "  signupInbox: { provider: mail, type: inbox }",
      "actors:",
      "  user:",
      "    flow: signup.flow.yaml",
      "    fixtures: { inbox: signupInbox }",
      "",
    ].join("\n"));
    const previous = process.env.POLYMUX_FIXTURE_MAIL_LOG;
    process.env.POLYMUX_FIXTURE_MAIL_LOG = logPath;
    try {
      const driver = new FixtureDriver();
      const events: RunEvent[] = [];
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir, onEvent: (event) => events.push(event) },
      );

      expect(batch.status).toBe("passed");
      expect(driver.steps.map(({ step }) => [step.kind, step.input.value ?? step.input.to]))
        .toEqual([
          ["enter", "signup-1@example.test"],
          ["enter", "482913"],
          ["navigate", "https://example.test/verify?token=private-token"],
        ]);
      expect(await readFile(logPath, "utf8")).toBe(
        "health:-\ncreate:-\nreceive:2000\ndestroy:-\n",
      );
      const serialized = JSON.stringify({ batch, events });
      expect(serialized).not.toContain("482913");
      expect(serialized).not.toContain("private-token");
      expect(serialized).not.toContain("one-time verification");
      expect(batch.runs[0]?.actors[0]?.run.steps[1]?.message)
        .toBe("Received matching email and extracted otp, link");
      expect(driver.containsSecrets.get("Verified signup")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_FIXTURE_MAIL_LOG;
      else process.env.POLYMUX_FIXTURE_MAIL_LOG = previous;
    }
  });

  it("receives SMS mid-flow through the provider protocol and redacts secrets", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-fixture-sms-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "signup.flow.yaml"), [
      "version: 1",
      "name: SMS signup",
      "steps:",
      "  - enter:",
      "      target: { label: Phone }",
      "      value: ${fixtures.phone.values.number}",
      "  - receiveSms:",
      "      fixture: phone",
      "      saveAs: verification",
      "      timeoutMs: 2000",
      "      match:",
      "        from: '+15550001111'",
      "        body: sign-in",
      "      extract: [otp, link]",
      "  - enter:",
      "      target: { label: Verification code }",
      "      value: ${messages.verification.secrets.otp}",
      "  - navigate: ${messages.verification.secrets.link}",
      "",
    ].join("\n"));
    const logPath = join(projectDir, "sms-provider.log");
    const providerPath = join(projectDir, "sms-provider.mjs");
    await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.POLYMUX_FIXTURE_SMS_LOG, request.method + ":" + (request.timeoutMs ?? "-") + "\\n");
  let response = { protocol: request.protocol, id: request.id, ok: true };
  if (request.method === "create") response.result = {
    handle: "phone-1",
    values: { number: "+15550002222" }
  };
  if (request.method === "receive") response.result = {
    handle: request.handle,
    values: {
      id: "sms-1",
      from: "+15550001111",
      to: "+15550002222",
      receivedAt: "2026-07-23T12:00:00.000Z"
    },
    secrets: {
      body: "Your sign-in code is 593821. Continue: https://example.test/verify?token=sms-private-token"
    }
  };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`);
    const flowPath = join(directory, "signup-with-sms.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Signup with SMS verification",
      "providers:",
      "  sms:",
      `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(providerPath)}]`,
      "fixtures:",
      "  signupPhone: { provider: sms, type: phone }",
      "actors:",
      "  user:",
      "    flow: signup.flow.yaml",
      "    fixtures: { phone: signupPhone }",
      "",
    ].join("\n"));
    const previous = process.env.POLYMUX_FIXTURE_SMS_LOG;
    process.env.POLYMUX_FIXTURE_SMS_LOG = logPath;
    try {
      const driver = new FixtureDriver();
      const events: RunEvent[] = [];
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir, onEvent: (event) => events.push(event) },
      );

      expect(batch.status).toBe("passed");
      expect(driver.steps.map(({ step }) => [
        step.kind,
        step.input.value ?? step.input.to,
      ])).toEqual([
        ["enter", "+15550002222"],
        ["enter", "593821"],
        ["navigate", "https://example.test/verify?token=sms-private-token"],
      ]);
      expect(await readFile(logPath, "utf8")).toBe(
        "health:-\ncreate:-\nreceive:2000\ndestroy:-\n",
      );
      const serialized = JSON.stringify({ batch, events });
      expect(serialized).not.toContain("593821");
      expect(serialized).not.toContain("sms-private-token");
      expect(serialized).not.toContain("Your sign-in code");
      expect(batch.runs[0]?.actors[0]?.run.steps[1]?.message)
        .toBe("Received matching SMS and extracted otp, link");
      expect(driver.containsSecrets.get("SMS signup")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_FIXTURE_SMS_LOG;
      else process.env.POLYMUX_FIXTURE_SMS_LOG = previous;
    }
  });

  it("cleans up already-created resources when later provisioning fails", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-fixture-rollback-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "a.flow.yaml"), "version: 1\nname: A\nsteps:\n  - navigate: https://example.com\n");
    await writeFile(join(directory, "b.flow.yaml"), "version: 1\nname: B\nsteps:\n  - navigate: https://example.com\n");
    const logPath = join(projectDir, "rollback.log");
    const providerPath = join(projectDir, "rollback.mjs");
    await writeFile(providerPath, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.POLYMUX_FIXTURE_ROLLBACK_LOG, request.method + ":" + (request.fixture ?? "-") + "\\n");
  let response = { protocol: request.protocol, id: request.id, ok: true };
  if (request.method === "create" && request.fixture === "first") response.result = { handle: "first-1" };
  if (request.method === "create" && request.fixture === "second") response = {
    protocol: request.protocol, id: request.id, ok: false,
    error: { code: "unavailable", message: "No account available" }
  };
  process.stdout.write(JSON.stringify(response) + "\\n");
});
`);
    const flowPath = join(directory, "rollback.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Rollback fixtures",
      "providers:",
      "  app:",
      `    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(providerPath)}]`,
      "fixtures:",
      "  first: { provider: app, type: account }",
      "  second: { provider: app, type: account }",
      "actors:",
      "  a:",
      "    flow: a.flow.yaml",
      "    fixtures: { account: first }",
      "  b:",
      "    flow: b.flow.yaml",
      "    fixtures: { account: second }",
      "",
    ].join("\n"));
    const previous = process.env.POLYMUX_FIXTURE_ROLLBACK_LOG;
    process.env.POLYMUX_FIXTURE_ROLLBACK_LOG = logPath;
    try {
      await expect(runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        new FixtureDriver(),
        { projectDir },
      )).rejects.toThrow("No account available");
      expect(await readFile(logPath, "utf8")).toBe(
        "health:-\ncreate:first\ncreate:second\ndestroy:first\n",
      );
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_FIXTURE_ROLLBACK_LOG;
      else process.env.POLYMUX_FIXTURE_ROLLBACK_LOG = previous;
    }
  });

  it("supports the same protocol over HTTP with environment-sourced authorization", async () => {
    const requests: Array<{ method: string; authorization?: string }> = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      requests.push({ method: message.method, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(message.method === "create"
        ? { protocol: message.protocol, id: message.id, ok: true, result: {
            handle: "http-account",
            values: { email: "http@test.local" },
            secrets: { password: "http-password" },
          } }
        : { protocol: message.protocol, id: message.id, ok: true }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No provider port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-fixture-http-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeActors(directory);
    const flowPath = join(directory, "http.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: HTTP accounts",
      "providers:",
      "  app:",
      "    http:",
      `      url: http://127.0.0.1:${address.port}/fixtures`,
      "      headersFromEnv:",
      "        authorization: POLYMUX_FIXTURE_HTTP_AUTH",
      "fixtures:",
      "  buyerAccount: { provider: app, type: account }",
      "actors:",
      "  buyer:",
      "    flow: buyer.flow.yaml",
      "    fixtures: { account: buyerAccount }",
      "  observer: observer.flow.yaml",
      "",
    ].join("\n"));
    const previous = process.env.POLYMUX_FIXTURE_HTTP_AUTH;
    process.env.POLYMUX_FIXTURE_HTTP_AUTH = "Bearer test-provider";
    try {
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        new FixtureDriver(),
        { projectDir },
      );
      expect(batch.status).toBe("passed");
      expect(requests.map(({ method }) => method)).toEqual(["health", "create", "destroy"]);
      expect(requests.every(({ authorization }) => authorization === "Bearer test-provider")).toBe(true);
      await expect(runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        new FixtureDriver(),
        {
          projectDir,
          executionMode: "cloud",
          fixtureEnvironment: {
            POLYMUX_FIXTURE_HTTP_AUTH: "Bearer isolated-provider",
          },
        },
      )).rejects.toThrow('Cloud execution does not allow http fixture provider "app"');
      expect(requests).toHaveLength(3);
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_FIXTURE_HTTP_AUTH;
      else process.env.POLYMUX_FIXTURE_HTTP_AUTH = previous;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("waits for email through a managed HTTP fixture provider", async () => {
    const requests: Array<{ method: string; timeoutMs?: number; authorization?: string }> = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      requests.push({
        method: message.method,
        ...(typeof message.timeoutMs === "number" ? { timeoutMs: message.timeoutMs } : {}),
        ...(typeof request.headers.authorization === "string"
          ? { authorization: request.headers.authorization }
          : {}),
      });
      let result;
      if (message.method === "create") {
        result = { handle: "managed-inbox", values: { address: "managed@example.test" } };
      } else if (message.method === "receive") {
        result = {
          handle: message.handle,
          values: {
            id: "managed-message",
            from: "accounts@example.test",
            subject: "Password reset",
          },
          secrets: {
            text: "Reset your password: https://example.test/reset?token=managed-secret",
          },
        };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        protocol: message.protocol,
        id: message.id,
        ok: true,
        ...(result ? { result } : {}),
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No provider port");
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-managed-email-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "reset.flow.yaml"), [
      "version: 1",
      "name: Managed password reset",
      "steps:",
      "  - enter: { target: { label: Email }, value: '${fixtures.inbox.values.address}' }",
      "  - receiveEmail:",
      "      fixture: inbox",
      "      saveAs: reset",
      "      timeoutMs: 1500",
      "      match: { subject: Password reset }",
      "      extract: link",
      "  - navigate: ${messages.reset.secrets.link}",
      "",
    ].join("\n"));
    const flowPath = join(directory, "managed.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: Managed email",
      "providers:",
      "  mail:",
      "    http:",
      `      url: http://127.0.0.1:${address.port}/fixtures`,
      "      headersFromEnv: { authorization: POLYMUX_MANAGED_MAIL_AUTH }",
      "fixtures:",
      "  inbox: { provider: mail, type: inbox }",
      "actors:",
      "  user:",
      "    flow: reset.flow.yaml",
      "    fixtures: { inbox: inbox }",
      "",
    ].join("\n"));
    const previous = process.env.POLYMUX_MANAGED_MAIL_AUTH;
    process.env.POLYMUX_MANAGED_MAIL_AUTH = "Bearer managed-mail";
    try {
      const driver = new FixtureDriver();
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir },
      );
      expect(batch.status).toBe("passed");
      expect(driver.steps.at(-1)?.step.input.to)
        .toBe("https://example.test/reset?token=managed-secret");
      expect(requests.map(({ method }) => method))
        .toEqual(["health", "create", "receive", "destroy"]);
      expect(requests.find(({ method }) => method === "receive")?.timeoutMs).toBe(1500);
      expect(requests.every(({ authorization }) => authorization === "Bearer managed-mail"))
        .toBe(true);
      expect(JSON.stringify(batch)).not.toContain("managed-secret");
    } finally {
      if (previous === undefined) delete process.env.POLYMUX_MANAGED_MAIL_AUTH;
      else process.env.POLYMUX_MANAGED_MAIL_AUTH = previous;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("creates scoped signed challenge assertions without exposing them in results", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-challenge-"));
    const directory = join(projectDir, "polymux");
    await mkdir(directory);
    await writeFile(join(directory, "buyer.flow.yaml"), [
      "version: 1",
      "name: Challenge actor",
      "steps:",
      "  - navigate: https://example.com",
      "",
    ].join("\n"));
    await writeFile(join(directory, "observer.flow.yaml"), [
      "version: 1",
      "name: Challenge observer",
      "steps:",
      "  - navigate: https://example.com",
      "",
    ].join("\n"));
    const flowPath = join(directory, "challenge.flow.yaml");
    await writeFile(flowPath, [
      "version: 1",
      "name: CAPTCHA test gate",
      "providers:",
      "  testGate: { builtin: challenge }",
      "fixtures:",
      "  captcha:",
      "    provider: testGate",
      "    type: challenge",
      "    input: { audience: checkout-app, action: submit-order, ttlSeconds: 60 }",
      "actors:",
      "  buyer:",
      "    flow: buyer.flow.yaml",
      "    fixtures: { challenge: captcha }",
      "    headers:",
      "      x-polymux-test-assertion: ${fixtures.challenge.secrets.assertion}",
      "  observer: observer.flow.yaml",
      "",
    ].join("\n"));
    const previousSecret = process.env.POLYMUX_TEST_CHALLENGE_SECRET;
    const previousEnvironment = process.env.POLYMUX_TEST_ENVIRONMENT;
    const secret = "test-secret-with-at-least-thirty-two-characters";
    process.env.POLYMUX_TEST_CHALLENGE_SECRET = secret;
    process.env.POLYMUX_TEST_ENVIRONMENT = "test";
    try {
      const driver = new FixtureDriver();
      const batch = await runCoordinatedFlowInstances(
        await compileCoordinatedFlowFile(flowPath),
        driver,
        { projectDir },
      );
      const assertion = driver.headers.get("Challenge actor")?.["x-polymux-test-assertion"];
      expect(assertion).toBeTruthy();
      const claims = await verifyPolymuxTestChallenge(assertion!, {
        secret,
        audience: "checkout-app",
        action: "submit-order",
        environment: "test",
        consumeJti: () => true,
      });
      expect(claims.sub).toBe("buyer");
      expect(claims.flowRunId).toBe(batch.runs[0]?.flowRunId);
      const consumed = new Set<string>();
      const consumeJti = (jti: string) => {
        if (consumed.has(jti)) return false;
        consumed.add(jti);
        return true;
      };
      await verifyPolymuxTestChallenge(assertion!, {
        secret,
        audience: "checkout-app",
        action: "submit-order",
        environment: "test",
        consumeJti,
      });
      await expect(verifyPolymuxTestChallenge(assertion!, {
        secret,
        audience: "checkout-app",
        action: "submit-order",
        environment: "test",
        consumeJti,
      })).rejects.toThrow("already been consumed");
      expect(JSON.stringify(batch)).not.toContain(assertion);
      await expect(verifyPolymuxTestChallenge(assertion!, {
        secret,
        audience: "checkout-app",
        action: "submit-order",
        environment: "production",
        consumeJti: () => true,
      })).rejects.toThrow("explicitly non-production");
      for (const environment of ["live", "production-eu", "main", "prd"]) {
        await expect(verifyPolymuxTestChallenge(assertion!, {
          secret,
          audience: "checkout-app",
          action: "submit-order",
          environment,
          consumeJti: () => true,
        })).rejects.toThrow("explicitly non-production");
      }
    } finally {
      if (previousSecret === undefined) delete process.env.POLYMUX_TEST_CHALLENGE_SECRET;
      else process.env.POLYMUX_TEST_CHALLENGE_SECRET = previousSecret;
      if (previousEnvironment === undefined) delete process.env.POLYMUX_TEST_ENVIRONMENT;
      else process.env.POLYMUX_TEST_ENVIRONMENT = previousEnvironment;
    }
  });
});
