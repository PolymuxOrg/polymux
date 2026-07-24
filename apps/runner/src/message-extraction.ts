import { RuntimeFailure } from "@polymux/core";

const verificationWords =
  /\b(?:otp|one[- ]?time|verification|security|login|sign[- ]?in|confirmation|authenticate|authentication|authorization|passcode|code)\b/i;

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, raw: string) => {
    if (raw.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(raw.slice(2), 16));
    }
    if (raw.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(raw.slice(1), 10));
    }
    return named[raw.toLowerCase()] ?? entity;
  });
}

export function visibleHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t]+/g, " ");
}

function normalizedCode(value: string): string {
  return value.replace(/[- ]/g, "").toUpperCase();
}

export function extractVerificationOtp(text: string, medium: string): string {
  const withoutUrls = text.replace(/https?:\/\/[^\s<>"']+/gi, " ");
  const candidates = new Map<string, { score: number; index: number }>();
  const patterns = [
    /\b\d{3}[- ]\d{3}\b/g,
    /\b[A-Z0-9]{4,10}\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of withoutUrls.matchAll(pattern)) {
      const raw = match[0];
      const code = normalizedCode(raw);
      if (!/\d/.test(code)) continue;
      if (!/^[A-Z0-9]{4,10}$/.test(code)) continue;
      const index = match.index ?? 0;
      const context = withoutUrls.slice(Math.max(0, index - 100), index + raw.length + 60);
      let score = verificationWords.test(context) ? 10 : 0;
      if (/\b(?:otp|passcode|code)\b/i.test(context)) score += 4;
      if (/^\d{6}$/.test(code)) score += 2;
      if (/^(?:19|20)\d{2}$/.test(code)) score -= 6;
      const previous = candidates.get(code);
      if (!previous || score > previous.score) candidates.set(code, { score, index });
    }
  }
  if (candidates.size === 0) {
    throw new RuntimeFailure(`The ${medium} did not contain an OTP code`);
  }
  const ranked = [...candidates.entries()].sort(
    ([leftCode, left], [rightCode, right]) =>
      right.score - left.score || left.index - right.index || leftCode.localeCompare(rightCode),
  );
  const best = ranked[0]!;
  const tied = ranked.filter(([, candidate]) => candidate.score === best[1].score);
  if (tied.length > 1) {
    throw new RuntimeFailure(
      `The ${medium} contained ${tied.length} equally likely OTP codes; add a narrower ${medium} match`,
    );
  }
  return best[0];
}

function cleanUrlCandidate(value: string): string {
  return decodeHtml(value).replace(/[),.;]+$/, "");
}

export function extractVerificationLink(
  text: string,
  html: string,
  medium: string,
): string {
  const candidates = new Map<string, number>();
  const add = (raw: string) => {
    const cleaned = cleanUrlCandidate(raw);
    let url: URL;
    try {
      url = new URL(cleaned);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol)) return;
    const searchable = `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
    let score = 0;
    if (/(?:verify|confirm|activate|invitation|invite|reset|recover|magic|otp|token|auth|callback)/.test(searchable)) {
      score += 10;
    }
    if (/(?:unsubscribe|privacy|terms|tracking|preferences)/.test(searchable)) score -= 10;
    candidates.set(url.toString(), Math.max(candidates.get(url.toString()) ?? -Infinity, score));
  };
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    add(match[1] ?? match[2] ?? match[3] ?? "");
  }
  for (const match of `${text}\n${visibleHtml(html)}`.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    add(match[0]);
  }
  if (candidates.size === 0) {
    throw new RuntimeFailure(`The ${medium} did not contain an HTTP verification link`);
  }
  const ranked = [...candidates.entries()].sort(
    ([leftUrl, leftScore], [rightUrl, rightScore]) =>
      rightScore - leftScore || leftUrl.localeCompare(rightUrl),
  );
  const best = ranked[0]!;
  const tied = ranked.filter(([, score]) => score === best[1]);
  if (tied.length > 1) {
    throw new RuntimeFailure(
      `The ${medium} contained ${tied.length} equally likely links; add a narrower ${medium} match`,
    );
  }
  return best[0];
}

export function matchesSubstring(
  value: string | undefined,
  expected: string | undefined,
): boolean {
  return expected === undefined
    || (value ?? "").toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}
