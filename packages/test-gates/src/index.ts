import { createHmac, timingSafeEqual } from "node:crypto";

export interface PolymuxTestChallengeClaims {
  iss: "polymux:test-gates";
  aud: string;
  sub: string;
  action: string;
  flowRunId: string;
  instance: number;
  environment: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface VerifyPolymuxTestChallengeOptions {
  secret: string;
  audience: string;
  action: string;
  environment: string;
  now?: number;
  consumeJti: (
    jti: string,
    expiresAt: number,
  ) => boolean | Promise<boolean>;
}

export const polymuxTestEnvironments = [
  "ci",
  "dev",
  "development",
  "local",
  "preview",
  "qa",
  "sandbox",
  "stage",
  "staging",
  "test",
  "testing",
  "uat",
] as const;

const testEnvironmentSet = new Set<string>(polymuxTestEnvironments);
const maximumChallengeLifetimeSeconds = 300;

export function assertPolymuxTestEnvironment(value: string): string {
  const environment = value.trim().toLowerCase();
  if (!testEnvironmentSet.has(environment)) {
    throw new Error(
      `Polymux test challenges require an explicitly non-production environment (${polymuxTestEnvironments.join(", ")})`,
    );
  }
  return environment;
}

function assertChallengeLifetime(iat: number, exp: number, now: number): void {
  if (
    !Number.isInteger(iat) ||
    !Number.isInteger(exp) ||
    exp <= iat ||
    exp - iat > maximumChallengeLifetimeSeconds ||
    exp <= now ||
    iat > now + 30
  ) {
    throw new Error("Polymux test assertion lifetime was rejected");
  }
}

export function signPolymuxTestChallenge(
  claims: PolymuxTestChallengeClaims,
  secret: string,
): string {
  const environment = assertPolymuxTestEnvironment(claims.environment);
  if (secret.length < 32) throw new Error("Challenge secret is too short");
  assertChallengeLifetime(claims.iat, claims.exp, claims.iat);
  if (
    claims.iss !== "polymux:test-gates" ||
    !claims.aud ||
    !claims.sub ||
    !claims.action ||
    !claims.flowRunId ||
    !Number.isInteger(claims.instance) ||
    claims.instance < 1 ||
    !claims.jti
  ) {
    throw new Error("Polymux test assertion claims were rejected");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({ ...claims, environment }))
    .toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export async function verifyPolymuxTestChallenge(
  token: string,
  options: VerifyPolymuxTestChallengeOptions,
): Promise<PolymuxTestChallengeClaims> {
  const environment = assertPolymuxTestEnvironment(options.environment);
  if (options.secret.length < 32) throw new Error("Challenge secret is too short");
  if (token.length > 8_192) throw new Error("Invalid Polymux test assertion");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Polymux test assertion");
  const [header, payload, signature] = parts as [string, string, string];
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Polymux test assertion header");
  }
  if (
    typeof headerValue !== "object" ||
    headerValue === null ||
    (headerValue as Record<string, unknown>).alg !== "HS256" ||
    (headerValue as Record<string, unknown>).typ !== "JWT"
  ) {
    throw new Error("Unsupported Polymux test assertion algorithm");
  }
  const expected = createHmac("sha256", options.secret)
    .update(`${header}.${payload}`)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid Polymux test assertion signature");
  }
  let claims: PolymuxTestChallengeClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PolymuxTestChallengeClaims;
  } catch {
    throw new Error("Invalid Polymux test assertion payload");
  }
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  assertChallengeLifetime(claims.iat, claims.exp, now);
  if (
    claims.iss !== "polymux:test-gates" ||
    claims.aud !== options.audience ||
    claims.action !== options.action ||
    claims.environment !== environment ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 180 ||
    typeof claims.flowRunId !== "string" ||
    claims.flowRunId.length === 0 ||
    claims.flowRunId.length > 255 ||
    !Number.isInteger(claims.instance) ||
    claims.instance < 1 ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    claims.jti.length > 180
  ) {
    throw new Error("Polymux test assertion claims were rejected");
  }
  if (!(await options.consumeJti(claims.jti, claims.exp))) {
    throw new Error("Polymux test assertion has already been consumed");
  }
  return claims;
}
