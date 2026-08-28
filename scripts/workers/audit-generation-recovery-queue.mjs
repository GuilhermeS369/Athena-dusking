import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const clockResponse = await fetch(`${required("NEXT_PUBLIC_SUPABASE_URL")}/rest/v1/`, {
  headers: { apikey: required("SUPABASE_SERVICE_ROLE_KEY") },
});
const databaseNow = new Date(clockResponse.headers.get("date") ?? Date.now());

const { data: chunks, error: chunksError } = await supabase
  .from("bulk_publication_generation_chunks")
  .select("plan_id,plan_profile_id,status,slot_count,next_slot_index,slot_start,retry_exhausted_at,lease_until")
  .in("status", ["queued", "processing", "failed", "paused"])
  .limit(5000);
if (chunksError) throw new Error(`${chunksError.code ?? "QUERY_ERROR"}: ${chunksError.message}`);

const planIds = [...new Set(chunks.map((chunk) => chunk.plan_id))];
const profilePlanIds = [...new Set(chunks.map((chunk) => chunk.plan_profile_id))];
const { data: plans, error: plansError } = planIds.length === 0
  ? { data: [], error: null }
  : await supabase.from("bulk_publication_plans")
      .select("id,name,status,created_at,interval_minutes")
      .in("id", planIds);
if (plansError) throw new Error(`${plansError.code ?? "QUERY_ERROR"}: ${plansError.message}`);
const plansById = new Map(plans.map((plan) => [plan.id, plan]));
const profilePlans = [];
for (let offset = 0; offset < profilePlanIds.length; offset += 100) {
  const { data, error } = await supabase.from("bulk_publication_plan_profiles")
    .select("id,schedule_base_at")
    .in("id", profilePlanIds.slice(offset, offset + 100));
  if (error) throw new Error(`${error.code ?? "QUERY_ERROR"}: ${error.message}`);
  profilePlans.push(...data);
}
const profilePlansById = new Map(profilePlans.map((profilePlan) => [profilePlan.id, profilePlan]));

const summary = new Map();
for (const chunk of chunks) {
  const plan = plansById.get(chunk.plan_id);
  const current = summary.get(chunk.plan_id) ?? {
    planId: chunk.plan_id,
    name: plan?.name ?? null,
    planStatus: plan?.status ?? null,
    createdAt: plan?.created_at ?? null,
    queued: 0,
    processing: 0,
    failed: 0,
    paused: 0,
    remainingSlots: 0,
    activeLeases: 0,
    exhausted: 0,
    eligibleNow: 0,
  };
  current[chunk.status] += 1;
  current.remainingSlots += Number(chunk.slot_start) + Number(chunk.slot_count) - Number(chunk.next_slot_index);
  if (chunk.lease_until && Date.parse(chunk.lease_until) > Date.now()) current.activeLeases += 1;
  if (chunk.retry_exhausted_at) current.exhausted += 1;
  const profilePlan = profilePlansById.get(chunk.plan_profile_id);
  const nextExecuteAt = profilePlan && plan
    ? Date.parse(profilePlan.schedule_base_at)
      + (Number(chunk.next_slot_index) + 1) * Number(plan.interval_minutes) * 60_000
    : Number.POSITIVE_INFINITY;
  if (["queued", "processing", "failed"].includes(chunk.status)
    && !chunk.retry_exhausted_at
    && nextExecuteAt <= databaseNow.getTime() + 48 * 60 * 60_000) current.eligibleNow += 1;
  summary.set(chunk.plan_id, current);
}

process.stdout.write(`${JSON.stringify({
  databaseNow: databaseNow.toISOString(),
  chunkRows: chunks.length,
  plans: [...summary.values()].sort((left, right) =>
    String(left.createdAt).localeCompare(String(right.createdAt)) || left.planId.localeCompare(right.planId)),
}, null, 2)}\n`);
