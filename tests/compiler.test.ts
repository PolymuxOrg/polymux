import { describe, expect, it } from "vitest";
import {
  compileSingleActorFlow,
  FlowCompileError,
} from "@polymux/core";

describe("flow compiler", () => {
  it("compiles portable steps into a deterministic plan", () => {
    const first = compileSingleActorFlow(
      {
        version: 1,
        name: "Portable checkout",
        tags: ["smoke", "critical", "smoke"],
        knownFailure: {
          reason: "Confirmed checkout regression",
          expires: "2999-01-01",
        },
        platforms: ["web", "ios", "ipados", "android", "macos", "windows", "linux"],
        steps: [
          { launch: { app: "shop" } },
          { navigate: "checkout" },
          {
            activate: {
              role: "button",
              name: "Pay now",
              alternatives: [{ testId: "pay" }],
            },
          },
          { stabilize: { timeoutMs: 2_000 } },
          { expect: { text: "Order confirmed" } },
          {
            platform: {
              on: "ios",
              command: "acceptPermission",
              args: { permission: "camera" },
            },
          },
        ],
      },
      "/project/polymux/checkout.yaml",
    );
    const second = compileSingleActorFlow(
      {
        version: 1,
        name: "Portable checkout",
        tags: ["smoke", "critical", "smoke"],
        knownFailure: {
          reason: "Confirmed checkout regression",
          expires: "2999-01-01",
        },
        platforms: ["web", "ios", "ipados", "android", "macos", "windows", "linux"],
        steps: [
          { launch: { app: "shop" } },
          { navigate: "checkout" },
          {
            activate: {
              role: "button",
              name: "Pay now",
              alternatives: [{ testId: "pay" }],
            },
          },
          { stabilize: { timeoutMs: 2_000 } },
          { expect: { text: "Order confirmed" } },
          {
            platform: {
              on: "ios",
              command: "acceptPermission",
              args: { permission: "camera" },
            },
          },
        ],
      },
      "/project/polymux/checkout.yaml",
    );

    expect(first.hash).toBe(second.hash);
    expect(first.tags).toEqual(["smoke", "critical"]);
    expect(first.knownFailure).toEqual({
      reason: "Confirmed checkout regression",
      expires: "2999-01-01",
    });
    expect(first.requiredCapabilities).toEqual([
      "session.launch",
      "navigation.navigate",
      "interaction.activate",
      "motion.awaitStable",
      "assertion.ui",
      "extension.ios.acceptPermission",
    ]);
    expect(first.steps[2]?.input.target).toEqual({
      strategies: [
        { kind: "role", role: "button", name: "Pay now" },
        { kind: "testId", value: "pay" },
      ],
    });
  });

  it("rejects invalid flows with a useful path", () => {
    expect(() =>
      compileSingleActorFlow({
        version: 1,
        name: "Broken",
        platforms: ["web"],
        steps: [{ activate: {} }],
      }),
    ).toThrow(FlowCompileError);

    try {
      compileSingleActorFlow({
        version: 1,
        name: "Broken",
        platforms: ["web"],
        steps: [{ activate: {} }],
      });
    } catch (error) {
      expect((error as Error).message).toContain("steps.0");
    }
  });

  it("rejects expired known failures", () => {
    expect(() =>
      compileSingleActorFlow({
        version: 1,
        name: "Expired failure",
        knownFailure: {
          reason: "This needs a current decision",
          expires: "2000-01-01",
        },
        steps: [{ wait: 1 }],
      }),
    ).toThrow("Known failure expired");
  });

  it("supports controlled time and visual assertions as separate capabilities", () => {
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Animation",
      steps: [
        { clock: { action: "install" } },
        { activate: "Start animation" },
        { clock: { action: "advance", ms: 100 } },
        { visual: { name: "animation-100ms", threshold: 0.02 } },
      ],
    });

    expect(plan.requiredCapabilities).toEqual([
      "time.control",
      "interaction.activate",
      "visual.compare",
    ]);
  });

  it("accepts the concise empty stabilize syntax", () => {
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Settle",
      steps: [{ stabilize: null }],
    });

    expect(plan.steps[0]).toMatchObject({
      kind: "stabilize",
      input: { intervalMs: 100 },
    });
  });

  it("compiles exact focus targets and uses a subtle visual default", () => {
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Deterministic focus",
      platforms: ["web"],
      steps: [
        { focus: { role: "button", name: "Pay now", exact: true } },
        { visual: { name: "focused-control" } },
      ],
    });

    expect(plan.requiredCapabilities).toEqual([
      "interaction.focus",
      "visual.compare",
    ]);
    expect(plan.steps[0]?.input.target).toEqual({
      strategies: [
        { kind: "role", role: "button", name: "Pay now", exact: true },
      ],
    });
    expect(plan.steps[1]?.input.threshold).toBe(0.0001);
  });

  it("compiles deterministic email receipt steps and rejects duplicate outputs", () => {
    const plan = compileSingleActorFlow({
      version: 1,
      name: "Email verification",
      steps: [
        {
          receiveEmail: {
            fixture: "inbox",
            saveAs: "verification",
            timeoutMs: 45_000,
            match: { subject: "Verify" },
            extract: ["otp", "otp", "link"],
          },
        },
        {
          enter: {
            target: { label: "Code" },
            value: "${messages.verification.secrets.otp}",
          },
        },
      ],
    });

    expect(plan.requiredCapabilities).toEqual([
      "messaging.receiveEmail",
      "interaction.enter",
    ]);
    expect(plan.steps[0]).toMatchObject({
      kind: "receiveEmail",
      timeoutMs: 45_000,
      input: {
        fixture: "inbox",
        saveAs: "verification",
        match: { subject: "Verify" },
        extract: ["otp", "link"],
      },
    });

    expect(() => compileSingleActorFlow({
      version: 1,
      name: "Duplicate email outputs",
      steps: [
        { receiveEmail: { fixture: "inbox", saveAs: "message", extract: "otp" } },
        { receiveEmail: { fixture: "inbox", saveAs: "message", extract: "link" } },
      ],
    })).toThrow('Message result name "message" is used more than once');
  });

  it("compiles deterministic SMS receipt steps and shares message output names", () => {
    const plan = compileSingleActorFlow({
      version: 1,
      name: "SMS verification",
      steps: [
        {
          receiveSms: {
            fixture: "phone",
            saveAs: "verification",
            timeoutMs: 45_000,
            match: { from: "+15550001111", body: "sign in" },
            extract: ["otp", "otp", "link"],
          },
        },
        {
          enter: {
            target: { label: "Code" },
            value: "${messages.verification.secrets.otp}",
          },
        },
      ],
    });

    expect(plan.requiredCapabilities).toEqual([
      "messaging.receiveSms",
      "interaction.enter",
    ]);
    expect(plan.steps[0]).toMatchObject({
      kind: "receiveSms",
      timeoutMs: 45_000,
      input: {
        fixture: "phone",
        saveAs: "verification",
        match: { from: "+15550001111", body: "sign in" },
        extract: ["otp", "link"],
      },
    });

    expect(() => compileSingleActorFlow({
      version: 1,
      name: "Cross-channel duplicate outputs",
      steps: [
        { receiveEmail: { fixture: "inbox", saveAs: "message", extract: "otp" } },
        { receiveSms: { fixture: "phone", saveAs: "message", extract: "otp" } },
      ],
    })).toThrow('Message result name "message" is used more than once');
  });
});
