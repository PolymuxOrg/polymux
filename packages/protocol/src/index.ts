import { z } from "zod";

export const platforms = [
  "web",
  "ios",
  "ipados",
  "android",
  "macos",
  "windows",
  "linux",
] as const;

export type Platform = (typeof platforms)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const capabilities = {
  launch: "session.launch",
  terminate: "session.terminate",
  reset: "session.reset",
  navigate: "navigation.navigate",
  deepLink: "navigation.deepLink",
  activate: "interaction.activate",
  focus: "interaction.focus",
  enter: "interaction.enter",
  select: "interaction.select",
  clear: "interaction.clear",
  key: "interaction.key",
  pointer: "interaction.pointer",
  scroll: "interaction.scroll",
  swipe: "interaction.swipe",
  drag: "interaction.drag",
  multiTouch: "interaction.multiTouch",
  wait: "synchronization.wait",
  expect: "assertion.ui",
  screenshot: "evidence.screenshot",
  request: "network.request",
  mock: "network.mock",
  unmock: "network.unmock",
  stabilize: "motion.awaitStable",
  clock: "time.control",
  visual: "visual.compare",
  signal: "coordination.signal",
  waitForSignal: "coordination.waitForSignal",
  receiveEmail: "messaging.receiveEmail",
  receiveSms: "messaging.receiveSms",
} as const;

export type Capability =
  | (typeof capabilities)[keyof typeof capabilities]
  | `extension.${Platform}.${string}`;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const targetObjectSchema = z
  .object({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
    accessibilityId: z.string().min(1).optional(),
    image: z.string().min(1).optional(),
    exact: z.boolean().optional(),
    alternatives: z.array(z.unknown()).optional(),
  })
  .strict();

export type TargetSource =
  | string
  | {
      role?: string | undefined;
      name?: string | undefined;
      label?: string | undefined;
      text?: string | undefined;
      testId?: string | undefined;
      id?: string | undefined;
      css?: string | undefined;
      accessibilityId?: string | undefined;
      image?: string | undefined;
      exact?: boolean | undefined;
      alternatives?: TargetSource[] | undefined;
    };

export const targetSourceSchema: z.ZodType<TargetSource> = z.lazy(() =>
  z.union([
    z.string().min(1),
    targetObjectSchema
      .extend({ alternatives: z.array(targetSourceSchema).optional() })
      .refine(
        (value) =>
          Object.entries(value).some(
            ([key, entry]) =>
              key !== "alternatives" &&
              typeof entry === "string" &&
              entry.length > 0,
          ) || (value.alternatives?.length ?? 0) > 0,
        "A target needs at least one locator",
      ),
  ]),
);

const targetOrWrappedSchema = z.union([
  targetSourceSchema,
  z.object({ target: targetSourceSchema }).strict(),
]);

const launchSchema = z.union([
  z.string().min(1),
  z
    .object({
      app: z.string().min(1).optional(),
      clearState: z.boolean().optional(),
    })
    .strict(),
]);

const navigateSchema = z.union([
  z.string().min(1),
  z.object({ to: z.string().min(1) }).strict(),
]);

const flowVariableNameSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_-]*$/,
  "Names may contain letters, numbers, _ and -",
);

const receiveEmailSchema = z
  .object({
    fixture: flowVariableNameSchema,
    saveAs: flowVariableNameSchema,
    timeoutMs: z.number().positive().optional(),
    match: z
      .object({
        from: z.string().min(1).optional(),
        subject: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    extract: z.union([
      z.enum(["otp", "link"]),
      z.array(z.enum(["otp", "link"])).min(1),
    ]),
  })
  .strict();

const receiveSmsSchema = z
  .object({
    fixture: flowVariableNameSchema,
    saveAs: flowVariableNameSchema,
    timeoutMs: z.number().positive().optional(),
    match: z
      .object({
        from: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    extract: z.union([
      z.enum(["otp", "link"]),
      z.array(z.enum(["otp", "link"])).min(1),
    ]),
  })
  .strict();

const stepSchema = z.union([
  z.object({ flow: z.string().min(1) }).strict(),
  z.object({ launch: launchSchema }).strict(),
  z.object({ terminate: z.union([z.boolean(), z.string()]) }).strict(),
  z.object({ reset: z.union([z.boolean(), z.string()]) }).strict(),
  z.object({ navigate: navigateSchema }).strict(),
  z.object({ deepLink: navigateSchema }).strict(),
  z.object({ activate: targetOrWrappedSchema }).strict(),
  z.object({ focus: targetOrWrappedSchema }).strict(),
  z
    .object({
      enter: z
        .object({
          target: targetSourceSchema,
          value: z.union([z.string(), z.number(), z.boolean()]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      select: z
        .object({
          target: targetSourceSchema,
          value: z.union([z.string(), z.array(z.string())]),
        })
        .strict(),
    })
    .strict(),
  z.object({ clear: targetOrWrappedSchema }).strict(),
  z.object({ key: z.union([z.string().min(1), z.object({ value: z.string().min(1) }).strict()]) }).strict(),
  z
    .object({
      pointer: z
        .object({
          x: z.number(),
          y: z.number(),
          button: z.enum(["left", "right", "middle"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      scroll: z
        .object({
          target: targetSourceSchema.optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      swipe: z
        .object({
          direction: z.enum(["up", "down", "left", "right"]),
          distance: z.number().positive().optional(),
          target: targetSourceSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      drag: z
        .object({
          from: targetSourceSchema,
          to: targetSourceSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      multiTouch: z
        .object({
          gesture: z.enum(["tap", "pinch-in", "pinch-out"]),
          points: z
            .array(
              z
                .object({
                  x: z.number(),
                  y: z.number(),
                })
                .strict(),
            )
            .min(2),
          durationMs: z.number().nonnegative().default(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      wait: z.union([
        z.number().nonnegative(),
        z
          .object({
            target: targetSourceSchema.optional(),
            state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
            timeoutMs: z.number().positive().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      expect: z
        .object({
          target: targetSourceSchema.optional(),
          state: z
            .enum(["visible", "hidden", "attached", "detached", "enabled", "disabled"])
            .optional(),
          text: z.string().optional(),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
          count: z.number().int().nonnegative().optional(),
          timeoutMs: z.number().positive().optional(),
        })
        .strict()
        .refine(
          (value) =>
            value.target !== undefined ||
            value.text !== undefined ||
            value.value !== undefined ||
            value.count !== undefined,
          "An expectation needs a target or expected value",
        ),
    })
    .strict(),
  z
    .object({
      screenshot: z.union([
        z.string().min(1),
        z
          .object({
            name: z.string().min(1),
            target: targetSourceSchema.optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      request: z
        .object({
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
            .default("GET"),
          url: z.string().min(1),
          headers: z.record(z.string()).optional(),
          body: jsonValueSchema.optional(),
          expect: z
            .object({
              status: z.number().int().min(100).max(599).optional(),
              json: jsonValueSchema.optional(),
              text: z.string().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      mock: z
        .object({
          url: z.string().min(1),
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
            .optional(),
          response: z
            .object({
              status: z.number().int().min(100).max(599).default(200),
              headers: z.record(z.string()).optional(),
              json: jsonValueSchema.optional(),
              text: z.string().optional(),
            })
            .strict()
            .refine(
              (value) => value.json === undefined || value.text === undefined,
              "A mock response cannot define both json and text",
            ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      unmock: z.union([
        z.string().min(1),
        z.object({ url: z.string().min(1) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      stabilize: z
        .union([
          z
            .object({
              timeoutMs: z.number().positive().optional(),
              intervalMs: z.number().positive().optional(),
            })
            .strict(),
          z.null(),
          z.literal(true),
        ])
        .optional()
        .transform((value) =>
          typeof value === "object" && value !== null ? value : {},
        ),
    })
    .strict(),
  z
    .object({
      clock: z
        .object({
          action: z.enum(["install", "pause", "advance", "resume"]),
          ms: z.number().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      visual: z
        .object({
          name: z.string().min(1),
          target: targetSourceSchema.optional(),
          threshold: z.number().min(0).max(1).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      signal: z.union([
        z.string().min(1),
        z.object({ name: z.string().min(1) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      waitForSignal: z.union([
        z.string().min(1),
        z
          .object({
            name: z.string().min(1),
            timeoutMs: z.number().positive().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ receiveEmail: receiveEmailSchema }).strict(),
  z.object({ receiveSms: receiveSmsSchema }).strict(),
  z
    .object({
      platform: z
        .object({
          on: z.enum(platforms),
          command: z.string().min(1),
          args: z.record(jsonValueSchema).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type FlowStepSource = z.infer<typeof stepSchema>;

const tagSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Tags must use lowercase letters, numbers, and hyphens",
  );

const tagsSchema = z
  .array(tagSchema)
  .default([])
  .transform((tags) => [...new Set(tags)]);

const knownFailureSchema = z
  .object({
    reason: z.string().min(1),
    expires: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Known-failure expiry must use YYYY-MM-DD"),
  })
  .strict();

export const singleActorFlowSourceSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1),
    description: z.string().optional(),
    tags: tagsSchema,
    knownFailure: knownFailureSchema.optional(),
    platforms: z.array(z.enum(platforms)).min(1).default(["web"]),
    baseUrl: z.string().min(1).optional(),
    timeoutMs: z.number().positive().default(10_000),
    setup: z.array(stepSchema).default([]),
    steps: z.array(stepSchema).min(1),
    teardown: z.array(stepSchema).default([]),
  })
  .strict();

export type SingleActorFlowSource = z.infer<typeof singleActorFlowSourceSchema>;

const challengeProviderSourceSchema = z
  .object({
    builtin: z.literal("challenge"),
    config: z.object({}).strict().optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const supabaseProviderSourceSchema = z
  .object({
    builtin: z.literal("supabase"),
    config: z
      .object({
        url: z.string().url().optional(),
        urlFromEnv: z.string().min(1).optional(),
        serviceRoleKeyFromEnv: z.string().min(1).optional(),
        emailDomain: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const firebaseProviderSourceSchema = z
  .object({
    builtin: z.literal("firebase"),
    config: z
      .object({
        projectId: z.string().min(1).optional(),
        projectIdFromEnv: z.string().min(1).optional(),
        serviceAccountJsonFromEnv: z.string().min(1).optional(),
        createCustomToken: z.boolean().optional(),
        emailDomain: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const auth0ProviderSourceSchema = z
  .object({
    builtin: z.literal("auth0"),
    config: z
      .object({
        domain: z.string().min(1).optional(),
        domainFromEnv: z.string().min(1).optional(),
        apiBaseUrl: z.string().url().optional(),
        connection: z.string().min(1).optional(),
        managementTokenFromEnv: z.string().min(1).optional(),
        clientIdFromEnv: z.string().min(1).optional(),
        clientSecretFromEnv: z.string().min(1).optional(),
        emailDomain: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const clerkProviderSourceSchema = z
  .object({
    builtin: z.literal("clerk"),
    config: z
      .object({
        apiUrl: z.string().url().optional(),
        secretKeyFromEnv: z.string().min(1).optional(),
        emailDomain: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const mailpitProviderSourceSchema = z
  .object({
    builtin: z.literal("mailpit"),
    config: z
      .object({
        url: z.string().url().optional(),
        urlFromEnv: z.string().min(1).optional(),
        usernameFromEnv: z.string().min(1).optional(),
        passwordFromEnv: z.string().min(1).optional(),
        emailDomain: z.string().min(1).optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        maxMessageBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const twilioProviderSourceSchema = z
  .object({
    builtin: z.literal("twilio"),
    config: z
      .object({
        apiUrl: z.string().url().optional(),
        accountSidFromEnv: z.string().min(1).optional(),
        apiKeyFromEnv: z.string().min(1).optional(),
        apiKeySecretFromEnv: z.string().min(1).optional(),
        authTokenFromEnv: z.string().min(1).optional(),
        phoneNumberFromEnv: z.string().min(1).optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        maxMessageBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();

const fixtureProviderSourceSchema = z.union([
  z
    .object({
      command: z.array(z.string().min(1)).min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      http: z
        .object({
          url: z.string().url(),
          headersFromEnv: z.record(z.string().min(1)).optional(),
        })
        .strict(),
      timeoutMs: z.number().positive().optional(),
    })
    .strict(),
  challengeProviderSourceSchema,
  supabaseProviderSourceSchema,
  firebaseProviderSourceSchema,
  auth0ProviderSourceSchema,
  clerkProviderSourceSchema,
  mailpitProviderSourceSchema,
  twilioProviderSourceSchema,
]);

const fixtureSourceSchema = z
  .object({
    provider: z.string().min(1),
    type: z.string().min(1),
    input: jsonValueSchema.optional(),
  })
  .strict();

const protectionHeadersFromEnvSchema = z
  .record(z.string().min(1))
  .refine((headers) => Object.keys(headers).length > 0, {
    message: "A protection needs at least one header",
  });

const protectionSourceSchema = z.union([
  z
    .object({
      origin: z.string().url(),
      headersFromEnv: protectionHeadersFromEnvSchema,
    })
    .strict(),
  z
    .object({
      originFromEnv: z.string().min(1),
      headersFromEnv: protectionHeadersFromEnvSchema,
    })
    .strict(),
]);

const flowPathSchema = z.string().regex(
  /\.flow\.ya?ml$/i,
  "Actor flow references must use .flow.yaml or .flow.yml",
);

const flowActorSchema = z.union([
  flowPathSchema,
  z
    .object({
      flow: flowPathSchema,
      fixtures: z.record(z.string().min(1)).optional(),
      headers: z.record(z.string()).optional(),
    })
    .strict(),
]);

export const coordinatedFlowSourceSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1),
    description: z.string().optional(),
    tags: tagsSchema,
    knownFailure: knownFailureSchema.optional(),
    providers: z.record(fixtureProviderSourceSchema).optional(),
    protections: z.record(protectionSourceSchema).optional(),
    fixtures: z.record(fixtureSourceSchema).optional(),
    actors: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Actor names may contain letters, numbers, _ and -"),
        flowActorSchema,
      )
      .refine((actors) => Object.keys(actors).length >= 1, {
        message: "A coordinated flow needs at least one actor",
      }),
  })
  .strict();

export type CoordinatedFlowSource = z.infer<typeof coordinatedFlowSourceSchema>;
export const flowSourceSchema = z.union([
  singleActorFlowSourceSchema,
  coordinatedFlowSourceSchema,
]);
export type FlowSource = z.infer<typeof flowSourceSchema>;

export const fixtureProtocolVersion = "polymux.fixture/v1" as const;

const fixtureContextSchema = z
  .object({
    flow: z.string().min(1),
    flowRunId: z.string().min(1),
    instance: z.number().int().positive(),
    seed: z.string().min(1),
    actors: z.array(z.string().min(1)),
  })
  .strict();

const fixtureEnvelopeSchema = {
  protocol: z.literal(fixtureProtocolVersion),
  id: z.string().min(1),
};

export const fixtureRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...fixtureEnvelopeSchema, method: z.literal("health") }).strict(),
  z
    .object({
      ...fixtureEnvelopeSchema,
      method: z.literal("create"),
      fixture: z.string().min(1),
      fixtureType: z.string().min(1),
      context: fixtureContextSchema,
      input: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...fixtureEnvelopeSchema,
      method: z.literal("destroy"),
      fixture: z.string().min(1),
      fixtureType: z.string().min(1),
      handle: z.string().min(1),
      context: fixtureContextSchema,
    })
    .strict(),
  z
    .object({
      ...fixtureEnvelopeSchema,
      method: z.literal("receive"),
      fixture: z.string().min(1),
      fixtureType: z.string().min(1),
      handle: z.string().min(1),
      context: fixtureContextSchema,
      timeoutMs: z.number().positive(),
      input: jsonValueSchema.optional(),
    })
    .strict(),
]);

export type FixtureRequest = z.infer<typeof fixtureRequestSchema>;

const fixtureResourceSchema = z
  .object({
    handle: z.string().min(1),
    values: z.record(jsonValueSchema).optional(),
    secrets: z.record(jsonValueSchema).optional(),
    auth: jsonValueSchema.optional(),
  })
  .strict();

export const fixtureResponseSchema = z.union([
  z
    .object({
      protocol: z.literal(fixtureProtocolVersion),
      id: z.string().min(1),
      ok: z.literal(true),
      result: fixtureResourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(fixtureProtocolVersion),
      id: z.string().min(1),
      ok: z.literal(false),
      error: z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          retryable: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type FixtureResponse = z.infer<typeof fixtureResponseSchema>;
export type FixtureResource = z.infer<typeof fixtureResourceSchema>;

export type LocatorStrategy =
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "label"; value: string; exact?: boolean }
  | { kind: "testId"; value: string }
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "id"; value: string }
  | { kind: "css"; value: string }
  | { kind: "accessibilityId"; value: string }
  | { kind: "image"; value: string };

export interface CompiledTarget {
  strategies: LocatorStrategy[];
}

export type StepKind = keyof typeof capabilities | "platform";

export interface CompiledStep {
  id: string;
  kind: StepKind;
  capability: Capability;
  timeoutMs: number;
  input: Record<string, unknown>;
}

export interface CompiledFlowReference {
  id: string;
  kind: "flow";
  sourcePath: string;
  flow: CompiledSingleActorFlow;
}

export type CompiledFlowItem = CompiledStep | CompiledFlowReference;

export interface KnownFailure {
  reason: string;
  expires: string;
}

export interface KnownFailureResult extends KnownFailure {
  outcome: "expected-failure" | "unexpected-pass" | "error";
}

export interface CompiledSingleActorFlow {
  formatVersion: 1;
  name: string;
  description?: string;
  tags: string[];
  knownFailure?: KnownFailure;
  sourcePath: string;
  platforms: Platform[];
  baseUrl?: string;
  timeoutMs: number;
  requiredCapabilities: Capability[];
  hash: string;
  setup: CompiledFlowItem[];
  steps: CompiledFlowItem[];
  teardown: CompiledFlowItem[];
}

export interface CompiledFlowActor {
  name: string;
  flow: CompiledSingleActorFlow;
  fixtures: Record<string, string>;
  headers: Record<string, string>;
}

export type CompiledFixtureProvider =
  | { name: string; kind: "command"; command: string[]; cwd: string; timeoutMs: number }
  | { name: string; kind: "http"; url: string; headersFromEnv: Record<string, string>; timeoutMs: number }
  | { name: string; kind: "challenge"; config: Record<string, JsonValue>; timeoutMs: number }
  | { name: string; kind: "supabase"; config: Record<string, JsonValue>; timeoutMs: number }
  | { name: string; kind: "firebase"; config: Record<string, JsonValue>; timeoutMs: number }
  | { name: string; kind: "auth0"; config: Record<string, JsonValue>; timeoutMs: number }
  | { name: string; kind: "clerk"; config: Record<string, JsonValue>; timeoutMs: number }
  | { name: string; kind: "mailpit"; config: Record<string, JsonValue>; timeoutMs: number }
  | { name: string; kind: "twilio"; config: Record<string, JsonValue>; timeoutMs: number };

export interface CompiledProtection {
  name: string;
  origin?: string;
  originFromEnv?: string;
  headersFromEnv: Record<string, string>;
}

export interface CompiledFixture {
  name: string;
  provider: string;
  type: string;
  input?: JsonValue;
}

export interface CompiledCoordinatedFlow {
  formatVersion: 1;
  name: string;
  description?: string;
  tags: string[];
  knownFailure?: KnownFailure;
  sourcePath: string;
  hash: string;
  providers: CompiledFixtureProvider[];
  protections: CompiledProtection[];
  fixtures: CompiledFixture[];
  actors: CompiledFlowActor[];
}

export type CompiledFlow = CompiledSingleActorFlow | CompiledCoordinatedFlow;

export type StepStatus = "passed" | "failed" | "error" | "skipped";
export type RunStatus = "passed" | "failed" | "error";
export type StepPhase = "setup" | "steps" | "teardown";

export interface RunOrigin {
  kind: "local" | "remote";
  runnerId: string;
  host?: string;
  region?: string;
}

export interface StepResult {
  id: string;
  kind: StepKind;
  phase?: StepPhase;
  flowPath?: string[];
  status: StepStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message?: string;
  selectedStrategy?: LocatorStrategy;
  artifacts: string[];
  error?: {
    name: string;
    message: string;
    category: "assertion" | "runtime";
  };
}

export interface RunResult {
  formatVersion: 1;
  runId: string;
  flow: string;
  flowHash: string;
  sourcePath: string;
  /** Present on new results. Optional so older results remain readable. */
  tags?: string[];
  knownFailure?: KnownFailureResult;
  platform: Platform;
  /** Present on new results. Optional so older results remain readable. */
  origin?: RunOrigin;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifactsDir: string;
  artifacts: string[];
  steps: StepResult[];
  flowRunId?: string;
  actor?: string;
  instance?: number;
}

export interface CoordinatedFlowRunResult {
  formatVersion: 1;
  flowRunId: string;
  flow: string;
  flowHash: string;
  sourcePath: string;
  /** Present on new results. Optional so older results remain readable. */
  tags?: string[];
  knownFailure?: KnownFailureResult;
  instance: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  artifactsDir: string;
  protections: Array<{
    name: string;
    status: "configured";
  }>;
  fixtures: Array<{
    name: string;
    provider: string;
    type: string;
    status: "cleaned" | "cleanup-error";
  }>;
  actors: Array<{ actor: string; run: RunResult }>;
}

export type RunEvent = (
  | { type: "run.started"; runId: string; flow: string; at: string }
  | { type: "step.started"; runId: string; step: CompiledStep; at: string }
  | { type: "step.finished"; runId: string; result: StepResult; at: string }
  | { type: "run.finished"; runId: string; result: RunResult; at: string }
) & {
  flowRunId?: string;
  actor?: string;
  instance?: number;
};
