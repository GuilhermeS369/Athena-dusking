import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key)
  throw new Error(
    "Configure NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.",
  );
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const endedAt = new Date().toISOString();
const cutoff14d = new Date(Date.now() - 14 * 86_400_000).toISOString();
const cutoff48h = new Date(Date.now() - 2 * 86_400_000).toISOString();

function chunks(values, size = 100) {
  const result = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}
function severity(event, item) {
  if (event.event_type === "failed")
    return [
      String(event.error_code ?? "").includes("outcome_unknown")
        ? "critical"
        : "error",
      item.next_attempt_at ? "auto_recovering" : "action_required",
    ];
  if (["processing_deferred", "retry_requested"].includes(event.event_type))
    return ["warning", "auto_recovering"];
  if (["ignored", "suspended"].includes(event.event_type))
    return ["warning", "contained"];
  return ["info", "resolved"];
}

async function enrichAndInsert(sourceRows) {
  const itemIds = [
    ...new Set(sourceRows.map((row) => row.publication_item_id)),
  ];
  const itemRows = [];
  for (const part of chunks(itemIds)) {
    const { data, error } = await supabase
      .from("publication_items")
      .select(
        "id,organization_id,batch_id,profile_id,format,status,execute_at,next_attempt_at,attempt_count,meta_media_id,published_at",
      )
      .in("id", part);
    if (error) throw error;
    itemRows.push(...(data ?? []));
  }
  const profileIds = [...new Set(itemRows.map((row) => row.profile_id))],
    batchIds = [...new Set(itemRows.map((row) => row.batch_id))];
  const profiles = [],
    plans = [];
  for (const part of chunks(profileIds)) {
    const { data, error } = await supabase
      .from("instagram_profiles")
      .select("id,provider")
      .in("id", part);
    if (error) throw error;
    profiles.push(...(data ?? []));
  }
  for (const part of chunks(batchIds)) {
    const { data, error } = await supabase
      .from("bulk_publication_plans")
      .select("batch_id,origin_group_id,created_at")
      .in("batch_id", part)
      .order("created_at", { ascending: false });
    if (error) throw error;
    plans.push(...(data ?? []));
  }
  const itemById = new Map(itemRows.map((row) => [row.id, row])),
    providerByProfile = new Map(profiles.map((row) => [row.id, row.provider])),
    groupByBatch = new Map();
  for (const plan of plans)
    if (!groupByBatch.has(plan.batch_id))
      groupByBatch.set(plan.batch_id, plan.origin_group_id);
  const rows = sourceRows.flatMap((event) => {
    const item = itemById.get(event.publication_item_id);
    if (!item) return [];
    const [eventSeverity, treatment] = severity(event, item);
    const code = event.error_code || `publication_${event.event_type}`;
    const message =
      event.error_message ||
      ({
        queued: "Publicação agendada e registrada na fila.",
        processing_deferred:
          "Processamento adiado com nova tentativa programada.",
        published: "Publicação confirmada pelo provedor.",
        retry_requested: "Nova tentativa solicitada para a publicação.",
        cancelled: "Publicação cancelada.",
        ignored: "Publicação retirada da fila por uma contramedida.",
        suspended: "Publicação suspensa por uma contramedida operacional.",
        failed: "Falha durante o processamento da publicação.",
      }[event.event_type] ??
        "Evento de publicação registrado.");
    return [
      {
        occurred_at: event.created_at,
        organization_id: event.organization_id,
        domain: "publication",
        severity: eventSeverity,
        treatment_state: treatment,
        stage:
          event.event_type === "queued"
            ? "scheduled"
            : event.event_type === "published"
              ? "provider_confirmed"
              : ["processing_deferred", "processing_started"].includes(
                    event.event_type,
                  )
                ? "claimed"
                : "publication_outcome",
        event_type: event.event_type,
        stable_code: code,
        provider: providerByProfile.get(item.profile_id) ?? null,
        source_status: event.status,
        publication_format: item.format,
        profile_id: item.profile_id,
        source_group_id: groupByBatch.get(item.batch_id) ?? null,
        batch_id: item.batch_id,
        item_id: item.id,
        worker_name: event.actor_label,
        post_id: item.meta_media_id,
        source_type: "publication_item_event",
        source_id: event.id,
        message,
        countermeasure: {
          kind: item.next_attempt_at
            ? "automatic_retry"
            : ["ignored", "suspended"].includes(event.event_type)
              ? "automatic_containment"
              : null,
          nextAttemptAt: item.next_attempt_at,
          attemptCount: item.attempt_count,
        },
        evidence: {
          previousStatus: event.previous_status,
          status: event.status,
          executeAt: item.execute_at,
          publishedAt: item.published_at,
          metadata: event.metadata,
        },
      },
    ];
  });
  for (const part of chunks(rows, 50)) {
    const { error } = await supabase
      .from("instagram_observability_events")
      .upsert(part, {
        onConflict: "occurred_at,source_type,source_id",
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }
  return rows.length;
}

async function runPass(name, start, eventTypes, initialOffset = 0) {
  let offset = initialOffset,
    inserted = 0;
  while (true) {
    let query = supabase
      .from("publication_item_events")
      .select(
        "id,organization_id,publication_item_id,event_type,previous_status,status,actor_label,error_code,error_message,metadata,created_at",
      )
      .gte("created_at", start)
      .lte("created_at", endedAt)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (eventTypes) query = query.in("event_type", eventTypes);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    inserted += await enrichAndInsert(data);
    offset += data.length;
    console.log(
      JSON.stringify({ pass: name, read: offset, projected: inserted }),
    );
    if (data.length < 1000) break;
  }
}

const statusSources = [
  { table: "instagram_profiles", domain: "account", kind: "profile", select: "id,organization_id,status,provider,zernio_connection_id,last_error_code,last_error_message,updated_at" },
  { table: "zernio_connections", domain: "connection", kind: "connection", select: "id,organization_id,status,last_error_code,last_error_message,updated_at" },
  { table: "zernio_connection_attempts", domain: "connection", kind: "attempt", select: "id,organization_id,zernio_connection_id,status,last_error_message,updated_at" },
  { table: "publication_generation_jobs", domain: "scheduling", kind: "job", select: "id,organization_id,status,last_error_message,updated_at" },
  { table: "media_deletion_jobs", domain: "media", kind: "job", select: "id,organization_id,status,last_error_message,updated_at" },
  { table: "media_group_assignment_jobs", domain: "media", kind: "job", select: "id,organization_id,status,last_error_message,updated_at" },
  { table: "profile_analytics_refresh_jobs", domain: "analytics", kind: "job", select: "id,organization_id,status,last_error_message,updated_at" },
  { table: "zernio_profile_recycling_jobs", domain: "connection", kind: "job", select: "id,organization_id,status,last_error_code,last_error_message,updated_at" },
  { table: "media_assets", domain: "media", kind: "asset", select: "id,organization_id,status,kind,processing_error,updated_at", statuses: ["failed"] },
];

function classifyStatus(status) {
  if (["failed", "offline", "reauthorization_required"].includes(status)) return ["error", "action_required"];
  if (["completed_with_errors", "empty", "no_data"].includes(status)) return ["warning", "action_required"];
  if (["retrying", "remote_removal_pending", "paused"].includes(status)) return ["warning", "auto_recovering"];
  return ["info", "resolved"];
}

async function backfillStatusSources() {
  const totals = {};
  for (const source of statusSources) {
    let offset = 0, projected = 0;
    while (true) {
      let query = supabase.from(source.table).select(source.select)
        .gte("updated_at", cutoff14d).lte("updated_at", endedAt)
        .order("updated_at", { ascending: true }).order("id", { ascending: true })
        .range(offset, offset + 499);
      if (source.statuses) query = query.in("status", source.statuses);
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) break;
      const events = data.map((row) => {
        const [eventSeverity, treatment] = classifyStatus(row.status);
        const errorMessage = row.last_error_message ?? row.processing_error ?? null;
        return {
          occurred_at: row.updated_at,
          organization_id: row.organization_id,
          domain: source.domain,
          severity: eventSeverity,
          treatment_state: treatment,
          stage: `${source.table}_status`,
          event_type: "status_snapshot",
          stable_code: `${source.table}_${row.status}`,
          provider: row.provider ?? (source.table.startsWith("zernio_") ? "zernio" : null),
          source_status: row.status,
          profile_id: source.kind === "profile" ? row.id : null,
          connection_id: source.kind === "connection" ? row.id : (row.zernio_connection_id ?? null),
          job_id: source.kind === "job" ? row.id : null,
          attempt_id: source.kind === "attempt" ? row.id : null,
          source_type: `${source.table}_snapshot`,
          source_id: `${row.id}:${row.status}`,
          message: errorMessage || `${source.table.replaceAll("_", " ")} está em ${row.status}.`,
          countermeasure: treatment === "auto_recovering" ? { kind: "automatic_retry" } : {},
          evidence: { status: row.status, errorCode: row.last_error_code ?? null, mediaKind: row.kind ?? null },
        };
      });
      for (const part of chunks(events, 50)) {
        const { error: insertError } = await supabase.from("instagram_observability_events").upsert(part, {
          onConflict: "occurred_at,source_type,source_id", ignoreDuplicates: true,
        });
        if (insertError) throw insertError;
      }
      offset += data.length; projected += events.length;
      if (data.length < 500) break;
    }
    totals[source.table] = projected;
    console.log(JSON.stringify({ pass: "status-sources-14d", source: source.table, projected }));
  }
  return totals;
}

const requestedPass = process.env.OBSERVABILITY_BACKFILL_PASS ?? "all";
const requestedOffset = Math.max(0, Number(process.env.OBSERVABILITY_BACKFILL_OFFSET ?? 0) || 0);
if (requestedPass === "all" || requestedPass === "attention") await runPass("attention-14d", cutoff14d, [
  "failed", "retry_requested", "ignored", "suspended",
], requestedPass === "attention" ? requestedOffset : 0);
if (requestedPass === "all" || requestedPass === "timeline") await runPass(
  "timeline-48h", cutoff48h, null, requestedPass === "timeline" ? requestedOffset : 0,
);
if (requestedPass === "all" || requestedPass === "sources") await backfillStatusSources();
console.log(JSON.stringify({ completed: true, endedAt }));
