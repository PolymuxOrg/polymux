import type {
  ReceiveSmsRequest,
  ReceivedSms,
  SmsCoordination,
} from "@polymux/core";
import { RuntimeFailure } from "@polymux/core";
import type { FixtureResource, JsonValue } from "@polymux/protocol";
import {
  extractVerificationLink,
  extractVerificationOtp,
  matchesSubstring,
} from "./message-extraction.js";

const maximumExtractedBodyBytes = 1024 * 1024;

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function textField(
  value: Record<string, JsonValue>,
  key: string,
  required = false,
): string | undefined {
  const entry = value[key];
  if (entry === undefined && !required) return undefined;
  if (typeof entry !== "string" || entry.length === 0) {
    throw new RuntimeFailure(`Phone provider returned an invalid SMS ${key}`);
  }
  return entry;
}

export function extractReceivedSms(
  resource: FixtureResource,
  request: ReceiveSmsRequest,
): ReceivedSms {
  const values = record(resource.values);
  const rawSecrets = record(resource.secrets);
  const id = textField(values, "id", true)!;
  const from = textField(values, "from");
  const to = textField(values, "to");
  const receivedAt = textField(values, "receivedAt");
  const body = textField(rawSecrets, "body", true)!;
  if (Buffer.byteLength(body) > maximumExtractedBodyBytes) {
    throw new RuntimeFailure("Phone provider returned an SMS body larger than 1 MiB");
  }
  if (
    !matchesSubstring(from, request.match?.from)
    || !matchesSubstring(body, request.match?.body)
  ) {
    throw new RuntimeFailure(
      "Phone provider returned an SMS that did not match the requested sender or body",
    );
  }
  const secrets: Record<string, JsonValue> = {};
  for (const kind of request.extract) {
    if (kind === "otp") secrets.otp = extractVerificationOtp(body, "SMS");
    else secrets.link = extractVerificationLink(body, "", "SMS");
  }
  return {
    values: {
      id,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(receivedAt ? { receivedAt } : {}),
    },
    secrets,
    message: `Received matching SMS and extracted ${request.extract.join(", ")}`,
  };
}

export type PhoneReceiver = SmsCoordination;
