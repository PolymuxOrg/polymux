import type { EmailCoordination, ReceiveEmailRequest, ReceivedEmail } from "@polymux/core";
import { RuntimeFailure } from "@polymux/core";
import type { FixtureResource, JsonValue } from "@polymux/protocol";
import {
  extractVerificationLink,
  extractVerificationOtp,
  matchesSubstring,
  visibleHtml,
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
    throw new RuntimeFailure(`Inbox provider returned an invalid email ${key}`);
  }
  return entry;
}

function bodyField(value: Record<string, JsonValue>, key: string): string {
  const entry = value[key];
  if (entry === undefined) return "";
  if (typeof entry !== "string") {
    throw new RuntimeFailure(`Inbox provider returned an invalid email ${key}`);
  }
  return entry;
}

export function extractReceivedEmail(
  resource: FixtureResource,
  request: ReceiveEmailRequest,
): ReceivedEmail {
  const values = record(resource.values);
  const rawSecrets = record(resource.secrets);
  const id = textField(values, "id", true)!;
  const from = textField(values, "from");
  const subject = textField(values, "subject");
  const receivedAt = textField(values, "receivedAt");
  const text = bodyField(rawSecrets, "text");
  const html = bodyField(rawSecrets, "html");
  if (text.length === 0 && html.length === 0) {
    throw new RuntimeFailure("Inbox provider returned an email without a text or HTML body");
  }
  if (Buffer.byteLength(text) + Buffer.byteLength(html) > maximumExtractedBodyBytes) {
    throw new RuntimeFailure("Inbox provider returned an email body larger than 1 MiB");
  }
  if (
    !matchesSubstring(from, request.match?.from)
    || !matchesSubstring(subject, request.match?.subject)
  ) {
    throw new RuntimeFailure("Inbox provider returned an email that did not match the requested sender or subject");
  }
  const body = `${subject ?? ""}\n${text}\n${visibleHtml(html)}`;
  const secrets: Record<string, JsonValue> = {};
  for (const kind of request.extract) {
    if (kind === "otp") secrets.otp = extractVerificationOtp(body, "email");
    else secrets.link = extractVerificationLink(text, html, "email");
  }
  return {
    values: {
      id,
      ...(from ? { from } : {}),
      ...(subject ? { subject } : {}),
      ...(receivedAt ? { receivedAt } : {}),
    },
    secrets,
    message: `Received matching email and extracted ${request.extract.join(", ")}`,
  };
}

export type InboxReceiver = EmailCoordination;
