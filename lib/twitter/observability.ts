import { createHash } from "node:crypto";

export const TWITTER_OBSERVABILITY_DOMAINS = [
  "account",
  "scheduling",
  "publication",
  "worker",
  "connection",
  "analytics",
  "finance",
] as const;

export const TWITTER_INCIDENT_STATUSES = ["open", "investigating", "resolved"] as const;
export const TWITTER_OBSERVABILITY_SEVERITIES = ["info", "warning", "error", "critical"] as const;

export type TwitterObservabilityDomain = (typeof TWITTER_OBSERVABILITY_DOMAINS)[number];
export type TwitterIncidentStatus = (typeof TWITTER_INCIDENT_STATUSES)[number];
export type TwitterObservabilitySeverity = (typeof TWITTER_OBSERVABILITY_SEVERITIES)[number];
export type TwitterLogScope = "account" | "scheduling" | "publication" | "worker" | "connection" | "analytics_finance" | "activity";

export type TwitterLogCursor = { at: string; id: string };

const sensitiveKey = /(authorization|api.?key|token|secret|cookie|password|signed.?url|content|caption|body|encrypted)/i;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const url = /https?:\/\/\S+/gi;
const longNumber = /\b\d{5,}\b/g;

export function normalizeTwitterErrorMessage(value: unknown) {
  return String(value ?? "Falha X sem mensagem.")
    .replace(url, "<url>")
    .replace(uuid, "<id>")
    .replace(longNumber, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

export function sanitizeTwitterEvidence(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5) return {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key)) continue;
    if (raw === null || typeof raw === "boolean" || typeof raw === "number") result[key] = raw;
    else if (typeof raw === "string") result[key] = normalizeTwitterErrorMessage(raw).slice(0, 500);
    else if (Array.isArray(raw)) {
      result[key] = raw.slice(0, 30).map((entry) =>
        entry && typeof entry === "object" ? sanitizeTwitterEvidence(entry, depth + 1) : normalizeTwitterErrorMessage(entry).slice(0, 200),
      );
    } else result[key] = sanitizeTwitterEvidence(raw, depth + 1);
  }
  return result;
}

export function twitterObservabilityFingerprint(input: {
  domain: TwitterObservabilityDomain;
  stage: string;
  stableCode: string;
  httpStatus?: number | null;
  providerCode?: string | null;
  workerName?: string | null;
}) {
  const httpClass = input.httpStatus == null ? "none" : `${Math.floor(input.httpStatus / 100)}xx`;
  return createHash("sha256").update([
    "v1",
    input.domain,
    input.stage.trim().toLowerCase() || "unknown",
    input.stableCode.trim().toLowerCase() || "unknown",
    httpClass,
    input.providerCode?.trim().toLowerCase() || "none",
    input.workerName?.trim().toLowerCase() || "none",
  ].join("|")).digest("hex");
}

export function encodeTwitterLogCursor(cursor: TwitterLogCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeTwitterLogCursor(value: string | null): TwitterLogCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<TwitterLogCursor>;
    if (typeof parsed.at !== "string" || !Number.isFinite(Date.parse(parsed.at)) || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}

export function twitterLogDomainsForScope(scope: TwitterLogScope): TwitterObservabilityDomain[] {
  if (scope === "analytics_finance") return ["analytics", "finance"];
  if (scope === "activity") return [...TWITTER_OBSERVABILITY_DOMAINS];
  return [scope];
}

export function isTwitterLogScope(value: string | null): value is TwitterLogScope {
  return ["account", "scheduling", "publication", "worker", "connection", "analytics_finance", "activity"].includes(value ?? "");
}

export function boundedTwitterLogLimit(value: string | null, fallback = 50) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.trunc(parsed))) : fallback;
}

export function safeTwitterLogSearch(value: string | null) {
  return (value ?? "").replace(/[^\p{L}\p{N}@._:\- ]/gu, "").trim().slice(0, 120);
}

export function twitterSeverityForResult(value: string, httpStatus?: number | null): TwitterObservabilitySeverity {
  const normalized = value.toLowerCase();
  if (normalized === "outcome_unknown") return "critical";
  if (["confirmed_failure", "failed", "rejected"].includes(normalized)) return "error";
  if (normalized === "rate_limited" || normalized === "retry" || httpStatus === 429) return "warning";
  return "info";
}

