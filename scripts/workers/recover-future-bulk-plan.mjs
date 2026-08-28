import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const action = option("action");
const planId = option("plan-id");
const planName = option("plan-name");
const cutoff = option("cutoff");
const expectedProfiles = Number(option("expected-profiles"));
const reason = option("reason") ?? "operator_ordered_recovery_2026_08_28";

if (!action || !planId) throw new Error("Use --action e --plan-id.");
if (!["advance-preview", "advance", "hold", "preview", "repair", "repair-residue", "release", "status"].includes(action)) {
  throw new Error("Ação inválida para recuperação do plano.");
}
if (["preview", "repair"].includes(action) && (!planName || !cutoff)) {
  throw new Error("Preview/reparo exigem --plan-name e --cutoff.");
}
if (["advance-preview", "advance"].includes(action) && (!planName || !cutoff)) {
  throw new Error("Avanço exige --plan-name e --cutoff.");
}
if (action === "repair-residue" && (!planName || !Number.isInteger(expectedProfiles))) {
  throw new Error("Reparo residual exige --plan-name e --expected-profiles.");
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

if (action === "status") {
  const [planResult, chunksResult, profilesResult] = await Promise.all([
    supabase.from("bulk_publication_plans")
      .select("id,name,status,expected_publications,generated_publications,ignored_publications,failed_publications,completed_at")
      .eq("id", planId).single(),
    supabase.from("bulk_publication_generation_chunks")
      .select("id,profile_id,plan_profile_id,status,slot_start,slot_count,next_slot_index,generated_items,ignored_items,failed_items,retry_exhausted_at,lease_until,last_error_message")
      .eq("plan_id", planId),
    supabase.from("bulk_publication_plan_profiles")
      .select("id,profile_id,status,total_slot_count,next_slot_index,generated_slot_count,ignored_slot_count,failed_slot_count,suspension_reason")
      .eq("plan_id", planId),
  ]);
  for (const result of [planResult, chunksResult, profilesResult]) {
    if (result.error) throw new Error(`${result.error.code ?? "QUERY_ERROR"}: ${result.error.message}`);
  }
  const group = (rows, field) => Object.fromEntries(
    Object.entries(rows.reduce((summary, row) => {
      summary[row[field]] = (summary[row[field]] ?? 0) + 1;
      return summary;
    }, {})).sort(([left], [right]) => left.localeCompare(right)),
  );
  const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
  process.stdout.write(`${JSON.stringify({
    plan: planResult.data,
    chunks: {
      count: chunksResult.data.length,
      byStatus: group(chunksResult.data, "status"),
      slots: sum(chunksResult.data, "slot_count"),
      generated: sum(chunksResult.data, "generated_items"),
      ignored: sum(chunksResult.data, "ignored_items"),
      failed: sum(chunksResult.data, "failed_items"),
      activeLeases: chunksResult.data.filter((row) => row.lease_until && Date.parse(row.lease_until) > Date.now()).length,
      exhausted: chunksResult.data.filter((row) => row.retry_exhausted_at).length,
      anomalous: chunksResult.data.filter((row) => row.failed_items > 0 || row.retry_exhausted_at),
    },
    profiles: {
      count: profilesResult.data.length,
      byStatus: group(profilesResult.data, "status"),
      total: sum(profilesResult.data, "total_slot_count"),
      generated: sum(profilesResult.data, "generated_slot_count"),
      ignored: sum(profilesResult.data, "ignored_slot_count"),
      failed: sum(profilesResult.data, "failed_slot_count"),
      anomalous: profilesResult.data.filter((row) => row.status === "failed" || row.failed_slot_count > 0),
    },
  }, null, 2)}\n`);
  process.exit(0);
}

const request = ["advance-preview", "advance"].includes(action)
  ? supabase.rpc("advance_bulk_rotation_cursor_past_cutoff", {
      p_plan_id: planId,
      p_expected_name: planName,
      p_cutoff: cutoff,
      p_dry_run: action === "advance-preview",
    })
  : action === "repair-residue"
  ? supabase.rpc("repair_bulk_rotation_retry_counter_residue", {
      p_plan_id: planId,
      p_expected_name: planName,
      p_expected_profiles: expectedProfiles,
      p_hold_reason: reason,
    })
  : ["hold", "release"].includes(action)
  ? supabase.rpc("set_bulk_rotation_plan_generation_hold", {
      p_plan_id: planId,
      p_hold: action === "hold",
      p_reason: reason,
    })
  : supabase.rpc("recover_future_bulk_rotation_timeout_slots", {
      p_plan_id: planId,
      p_expected_name: planName,
      p_cutoff: cutoff,
      p_dry_run: action === "preview",
    });

const { data, error } = await request;
if (error) throw new Error(`${error.code ?? "RPC_ERROR"}: ${error.message}`);
process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
