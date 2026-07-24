import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  compileCoordinatedFlowFile,
  type Driver,
  type DriverSession,
  type DriverSessionContext,
} from "@polymux/core";
import {
  capabilities,
  type Capability,
  type CompiledFixtureProvider,
  type CompiledStep,
} from "@polymux/protocol";
import { runCoordinatedFlowInstances } from "@polymux/runner";
import { TwilioTransport } from "../apps/runner/src/twilio.js";

const accountSid = `AC${"1".repeat(32)}`;
const apiKey = `SK${"2".repeat(32)}`;
const apiKeySecret = "twilio-api-key-secret";
const phoneNumber = "+14155550123";
const senderNumber = "+14155550999";
const environmentNames = {
  account: "POLYMUX_TEST_TWILIO_ACCOUNT_SID",
  apiKey: "POLYMUX_TEST_TWILIO_API_KEY",
  apiKeySecret: "POLYMUX_TEST_TWILIO_API_KEY_SECRET",
  phone: "POLYMUX_TEST_TWILIO_PHONE_NUMBER",
};

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
}

const requests: RecordedRequest[] = [];
let messageListCalls = 0;
let baseUrl = "";

const server = createServer((request, response) => {
  requests.push({
    method: request.method ?? "",
    path: request.url ?? "",
    ...(typeof request.headers.authorization === "string"
      ? { authorization: request.headers.authorization }
      : {}),
  });
  response.setHeader("content-type", "application/json");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname.endsWith("/IncomingPhoneNumbers.json")) {
    response.end(JSON.stringify({
      incoming_phone_numbers: [{
        phone_number: phoneNumber,
        capabilities: { sms: true, voice: true, mms: true },
      }],
    }));
    return;
  }
  if (url.pathname.endsWith("/Messages.json")) {
    messageListCalls += 1;
    const oldMessage = {
      sid: `SM${"3".repeat(32)}`,
      body: "Old verification code 111111",
      from: senderNumber,
      to: phoneNumber,
      direction: "inbound",
      date_sent: new Date().toUTCString(),
      date_created: new Date().toUTCString(),
    };
    const messages = messageListCalls === 1
      ? [oldMessage]
      : [{
          sid: `SM${"4".repeat(32)}`,
          body:
            "Your sign-in code is 834201. Continue at https://example.test/verify?token=twilio-secret",
          from: senderNumber,
          to: phoneNumber,
          direction: "inbound",
          date_sent: new Date(Date.now() + 1_000).toUTCString(),
          date_created: new Date(Date.now() + 1_000).toUTCString(),
        }, {
          sid: `SM${"5".repeat(32)}`,
          body: "Stale sign-in code 222222",
          from: senderNumber,
          to: phoneNumber,
          direction: "inbound",
          date_sent: new Date(Date.now() - 60_000).toUTCString(),
          date_created: new Date(Date.now() - 60_000).toUTCString(),
        }, oldMessage];
    response.end(JSON.stringify({ messages }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

class SmsFlowDriver implements Driver {
  readonly id = "twilio-flow.web";
  readonly platform = "web" as const;
  readonly capabilities: ReadonlySet<Capability> = new Set([
    capabilities.enter,
    capabilities.navigate,
  ]);
  readonly steps: CompiledStep[] = [];
  containsSecrets = false;

  async createSession(context: DriverSessionContext): Promise<DriverSession> {
    this.containsSecrets = context.containsSecrets;
    return {
      execute: async (step) => {
        this.steps.push(step);
      },
      close: async () => [],
    };
  }
}

function fixtureEnvironment(): NodeJS.ProcessEnv {
  return {
    [environmentNames.account]: accountSid,
    [environmentNames.apiKey]: apiKey,
    [environmentNames.apiKeySecret]: apiKeySecret,
    [environmentNames.phone]: phoneNumber,
  };
}

function provider(
  config: Record<string, string | number> = {},
): Extract<CompiledFixtureProvider, { kind: "twilio" }> {
  return {
    name: "sms",
    kind: "twilio",
    config: {
      apiUrl: baseUrl,
      accountSidFromEnv: environmentNames.account,
      apiKeyFromEnv: environmentNames.apiKey,
      apiKeySecretFromEnv: environmentNames.apiKeySecret,
      phoneNumberFromEnv: environmentNames.phone,
      pollIntervalMs: 10,
      ...config,
    },
    timeoutMs: 1_000,
  };
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No Twilio test server port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  messageListCalls = 0;
});

describe("Twilio SMS fixture provider", () => {
  it("receives only a post-allocation SMS, extracts secrets, and continues", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "polymux-twilio-flow-"));
    const flowDir = join(projectDir, "polymux");
    await mkdir(flowDir);
    await writeFile(join(flowDir, "signup.flow.yaml"), [
      "version: 1",
      "name: Twilio signup",
      "steps:",
      "  - enter:",
      "      target: { label: Phone }",
      "      value: ${fixtures.phone.values.number}",
      "  - receiveSms:",
      "      fixture: phone",
      "      saveAs: verification",
      "      timeoutMs: 2000",
      `      match: { from: '${senderNumber}', body: sign-in }`,
      "      extract: [otp, link]",
      "  - enter:",
      "      target: { label: Code }",
      "      value: ${messages.verification.secrets.otp}",
      "  - navigate: ${messages.verification.secrets.link}",
      "",
    ].join("\n"));
    await writeFile(join(flowDir, "twilio.flow.yaml"), [
      "version: 1",
      "name: Twilio SMS verification",
      "providers:",
      "  sms:",
      "    builtin: twilio",
      "    config:",
      `      apiUrl: ${baseUrl}`,
      `      accountSidFromEnv: ${environmentNames.account}`,
      `      apiKeyFromEnv: ${environmentNames.apiKey}`,
      `      apiKeySecretFromEnv: ${environmentNames.apiKeySecret}`,
      `      phoneNumberFromEnv: ${environmentNames.phone}`,
      "      pollIntervalMs: 10",
      "fixtures:",
      "  projectPhone: { provider: sms, type: phone }",
      "actors:",
      "  user:",
      "    flow: signup.flow.yaml",
      "    fixtures: { phone: projectPhone }",
      "",
    ].join("\n"));

    const driver = new SmsFlowDriver();
    const result = await runCoordinatedFlowInstances(
      await compileCoordinatedFlowFile(join(flowDir, "twilio.flow.yaml")),
      driver,
      { projectDir, fixtureEnvironment: fixtureEnvironment() },
    );

    expect(result.status).toBe("passed");
    expect(driver.steps.map((step) => step.input.value ?? step.input.to)).toEqual([
      phoneNumber,
      "834201",
      "https://example.test/verify?token=twilio-secret",
    ]);
    expect(driver.containsSecrets).toBe(true);
    expect(JSON.stringify(result)).not.toContain("834201");
    expect(JSON.stringify(result)).not.toContain("twilio-secret");
    expect(JSON.stringify(result)).not.toContain("111111");
    expect(JSON.stringify(result)).not.toContain("222222");
    expect(result.runs[0]?.actors[0]?.run.steps[1]?.message)
      .toBe("Received matching SMS and extracted otp, link");
    expect(messageListCalls).toBe(2);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.some(({ path }) =>
      path.includes("IncomingPhoneNumbers.json")
      && path.includes(`PhoneNumber=${encodeURIComponent(phoneNumber)}`)
    )).toBe(true);
    expect(requests.filter(({ path }) => path.includes("Messages.json")))
      .toHaveLength(2);
    expect(requests.find(({ path }) => path.includes("Messages.json"))?.path)
      .toContain(`To=${encodeURIComponent(phoneNumber)}`);
    const expectedAuthorization =
      `Basic ${Buffer.from(`${apiKey}:${apiKeySecret}`).toString("base64")}`;
    expect(requests.every(({ authorization }) =>
      authorization === expectedAuthorization
    )).toBe(true);
  });

  it("fails closed while the same number is leased by another active run", async () => {
    const environment = fixtureEnvironment();
    const first = new TwilioTransport(provider(), environment);
    const second = new TwilioTransport(provider(), environment);
    try {
      expect((await first.call({ method: "health" })).ok).toBe(true);
      const created = await first.call({
        method: "create",
        fixture: "projectPhone",
        fixtureType: "phone",
        context: {
          flow: "First",
          flowRunId: "first-run",
          instance: 1,
          seed: "first-seed",
          actors: ["user"],
        },
      });
      expect(created.ok).toBe(true);
      const blocked = await second.call({
        method: "create",
        fixture: "projectPhone",
        fixtureType: "phone",
        context: {
          flow: "Second",
          flowRunId: "second-run",
          instance: 1,
          seed: "second-seed",
          actors: ["user"],
        },
      });
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.error.message).toContain(
        "already leased by another active run",
      );
      await first.close();
      const afterRelease = await second.call({
        method: "create",
        fixture: "projectPhone",
        fixtureType: "phone",
        context: {
          flow: "Second",
          flowRunId: "second-run",
          instance: 1,
          seed: "second-seed",
          actors: ["user"],
        },
      });
      expect(afterRelease.ok).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("rejects API URLs with extra components before sending credentials", async () => {
    const transport = new TwilioTransport(
      provider({ apiUrl: `${baseUrl}/proxy?target=twilio` }),
      fixtureEnvironment(),
    );
    const result = await transport.call({ method: "health" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain(
      "API URL must be a Twilio HTTPS API origin",
    );
    expect(requests).toHaveLength(0);

    const external = new TwilioTransport(
      provider({ apiUrl: "https://example.test" }),
      fixtureEnvironment(),
    );
    const externalResult = await external.call({ method: "health" });
    expect(externalResult.ok).toBe(false);
    expect(!externalResult.ok && externalResult.error.message).toContain(
      "API URL must be a Twilio HTTPS API origin",
    );
    expect(requests).toHaveLength(0);
  });
});
