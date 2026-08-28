import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
}

const cutoffArgument = process.argv.slice(2).find((value) => value.startsWith("--cutoff="));
const cutoff = cutoffArgument?.slice("--cutoff=".length);
if (!cutoff || Number.isNaN(Date.parse(cutoff))) throw new Error("Use --cutoff com timestamp ISO válido.");

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function count(build) {
  const query = build(supabase.from("publication_items").select("id", { count: "exact", head: true })
    .eq("pipeline_version", 2).is("archived_at", null));
  const { count: result, error } = await query;
  if (error) throw new Error(`${error.code ?? "COUNT_ERROR"}: ${error.message}`);
  return result ?? 0;
}

const [overdueUnstarted, overdueAccepted, dueTotal, futureWaiting] = await Promise.all([
  count((query) => query.in("status", ["waiting", "ready"]).lt("execute_at", cutoff).is("creation_id", null)),
  count((query) => query.in("status", ["waiting", "ready", "preparing", "publishing"]).lt("execute_at", cutoff).not("creation_id", "is", null)),
  count((query) => query.in("status", ["waiting", "ready", "preparing", "publishing"]).lt("execute_at", cutoff)),
  count((query) => query.in("status", ["waiting", "ready"]).gte("execute_at", cutoff).is("creation_id", null)),
]);
const { data: dueRows, error: dueRowsError } = await supabase.from("publication_items")
  .select("status,creation_id,lease_until,claimed_by")
  .eq("pipeline_version", 2)
  .is("archived_at", null)
  .in("status", ["waiting", "ready", "preparing", "publishing"])
  .lt("execute_at", cutoff)
  .limit(1000);
if (dueRowsError) throw new Error(`${dueRowsError.code ?? "DUE_ERROR"}: ${dueRowsError.message}`);
const dueBreakdown = dueRows.reduce((summary, row) => {
  const key = `${row.status}:${row.creation_id ? "accepted" : "unstarted"}`;
  summary[key] = (summary[key] ?? 0) + 1;
  return summary;
}, {});
const dueUnstartedInFlight = dueRows
  .filter((row) => !row.creation_id && ["preparing", "publishing"].includes(row.status))
  .map((row) => ({
    status: row.status,
    leaseUntil: row.lease_until,
    claimedBy: row.claimed_by,
    leaseActive: Boolean(row.lease_until && Date.parse(row.lease_until) > Date.now()),
  }));
const { data: pressureSignal, error: pressureError } = await supabase.rpc(
  "get_publication_generation_pressure_signal",
  { p_critical_delay_seconds: 60 },
);
if (pressureError) throw new Error(`${pressureError.code ?? "PRESSURE_ERROR"}: ${pressureError.message}`);
let oldestCriticalItem = null;
let criticalUnstarted = 0;
let criticalAccepted = 0;
if (pressureSignal?.criticalDelay && pressureSignal?.checkedAt) {
  const criticalBefore = new Date(Date.parse(pressureSignal.checkedAt) - 60_000).toISOString();
  const [{ data, error }, unstartedResult, acceptedResult] = await Promise.all([
    supabase.from("publication_items")
    .select("id,organization_id,profile_id,batch_id,status,execute_at,creation_id,next_attempt_at,lease_until,claimed_by,last_error_code,last_error_message,attempt_count")
    .eq("pipeline_version", 2)
    .is("archived_at", null)
    .in("status", ["waiting", "ready"])
    .lte("execute_at", criticalBefore)
    .order("execute_at", { ascending: true })
    .limit(1)
    .maybeSingle(),
    supabase.from("publication_items").select("id", { count: "exact", head: true })
      .eq("pipeline_version", 2).is("archived_at", null).in("status", ["waiting", "ready"])
      .lte("execute_at", criticalBefore).is("creation_id", null),
    supabase.from("publication_items").select("id", { count: "exact", head: true })
      .eq("pipeline_version", 2).is("archived_at", null).in("status", ["waiting", "ready"])
      .lte("execute_at", criticalBefore).not("creation_id", "is", null),
  ]);
  if (error) throw new Error(`${error.code ?? "ITEM_ERROR"}: ${error.message}`);
  if (unstartedResult.error) throw new Error(`${unstartedResult.error.code ?? "COUNT_ERROR"}: ${unstartedResult.error.message}`);
  if (acceptedResult.error) throw new Error(`${acceptedResult.error.code ?? "COUNT_ERROR"}: ${acceptedResult.error.message}`);
  oldestCriticalItem = data;
  criticalUnstarted = unstartedResult.count ?? 0;
  criticalAccepted = acceptedResult.count ?? 0;
}

process.stdout.write(`${JSON.stringify({ cutoff, overdueUnstarted, overdueAccepted, dueTotal, dueBreakdown, dueUnstartedInFlight, futureWaiting, pressureSignal, criticalUnstarted, criticalAccepted, oldestCriticalItem }, null, 2)}\n`);
