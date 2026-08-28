export const INSTAGRAM_LOG_SCOPES = [
  "account",
  "publication",
  "worker",
  "connection",
  "scheduling",
  "analytics",
  "media",
  "analytics_media",
  "activity",
] as const;
export const INSTAGRAM_DOMAINS = [
  "account",
  "scheduling",
  "publication",
  "worker",
  "connection",
  "analytics",
  "media",
] as const;
export const INSTAGRAM_SEVERITIES = [
  "info",
  "warning",
  "error",
  "critical",
] as const;
export const INSTAGRAM_TREATMENTS = [
  "action_required",
  "investigating",
  "auto_recovering",
  "contained",
  "resolved",
] as const;
export const INSTAGRAM_FORMATS = [
  "image",
  "reel",
  "story",
  "carousel",
] as const;

export type InstagramLogScope = (typeof INSTAGRAM_LOG_SCOPES)[number];
export type InstagramDomain = (typeof INSTAGRAM_DOMAINS)[number];
export type InstagramLogCursor = { at: string; id: string };

export function instagramDomainsForScope(
  scope: InstagramLogScope,
): InstagramDomain[] {
  if (scope === "analytics_media") return ["analytics", "media"];
  if (scope === "activity") return [...INSTAGRAM_DOMAINS];
  return [scope];
}

export function isInstagramLogScope(
  value: string | null,
): value is InstagramLogScope {
  return INSTAGRAM_LOG_SCOPES.includes(value as InstagramLogScope);
}

export function safeInstagramSearch(value: string | null, limit = 120) {
  return (value ?? "")
    .replace(/[^\p{L}\p{N}@._:\- ]/gu, "")
    .trim()
    .slice(0, limit);
}

export function boundedInstagramLimit(
  value: string | null,
  fallback = 50,
  maximum = 100,
) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(maximum, Math.trunc(parsed)))
    : fallback;
}

export function instagramPeriodDays(value: string | null) {
  if (value === "24h") return 1;
  if (value === "3d") return 3;
  if (value === "7d") return 7;
  return 14;
}

export function isUuid(value: string | null): value is string {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  );
}

export function encodeInstagramCursor(cursor: InstagramLogCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeInstagramCursor(
  value: string | null,
): InstagramLogCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<InstagramLogCursor>;
    if (
      typeof cursor.at !== "string" ||
      !Number.isFinite(Date.parse(cursor.at)) ||
      !isUuid(cursor.id ?? null)
    )
      return null;
    return { at: cursor.at, id: cursor.id! };
  } catch {
    return null;
  }
}

const sensitiveKey =
  /(authorization|api.?key|token|secret|cookie|password|signed.?url|content|caption|body|encrypted)/i;
export function sanitizeInstagramEvidence(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 5)
    return {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key)) continue;
    if (raw === null || typeof raw === "boolean" || typeof raw === "number")
      result[key] = raw;
    else if (typeof raw === "string")
      result[key] = raw
        .replace(/https?:\/\/\S+/gi, "[url removida]")
        .slice(0, 500);
    else if (Array.isArray(raw))
      result[key] = raw
        .slice(0, 30)
        .map((entry) =>
          typeof entry === "string" ? entry.slice(0, 200) : entry,
        );
    else result[key] = sanitizeInstagramEvidence(raw, depth + 1);
  }
  return result;
}

export const INSTAGRAM_DOMAIN_LABELS: Record<string, string> = {
  account: "Contas",
  scheduling: "Agendamento",
  publication: "Publicações",
  worker: "Workers",
  connection: "Conexões",
  analytics: "Analytics",
  media: "Mídia",
};

export const INSTAGRAM_TREATMENT_LABELS: Record<string, string> = {
  action_required: "Ação necessária",
  investigating: "Em investigação",
  auto_recovering: "Recuperação automática",
  contained: "Contido",
  resolved: "Resolvido",
};

export type InstagramIncidentAction = "investigate" | "resolve";

export function instagramIncidentActions(
  role: string,
  treatment: string,
): InstagramIncidentAction[] {
  if (!['admin', 'operator'].includes(role)) return [];
  const actions: InstagramIncidentAction[] = [];
  if (treatment !== "investigating") actions.push("investigate");
  if (treatment !== "resolved") actions.push("resolve");
  return actions;
}
