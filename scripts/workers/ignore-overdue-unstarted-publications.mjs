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

const cutoff = option("cutoff");
const limit = Number(option("limit") ?? 50);
const maxPages = Number(option("max-pages") ?? 100);
const reason = option("reason") ?? "operator_overdue_backlog_cleanup";
if (!cutoff || Number.isNaN(Date.parse(cutoff))) throw new Error("Use --cutoff com timestamp ISO válido.");
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit deve estar entre 1 e 100.");
if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error("--max-pages inválido.");

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let total = 0;
const pages = [];
for (let page = 1; page <= maxPages; page += 1) {
  const startedAt = performance.now();
  const { data, error } = await supabase.rpc("ignore_overdue_unstarted_publications", {
    p_before: cutoff,
    p_limit: limit,
    p_reason: reason,
  });
  if (error) throw new Error(`${error.code ?? "RPC_ERROR"}: ${error.message}`);
  const ignored = Number(data?.ignored ?? 0);
  const durationMs = Math.round(performance.now() - startedAt);
  pages.push({ page, ignored, durationMs });
  total += ignored;
  if (ignored === 0) break;
  if (page === maxPages) throw new Error("Limite de páginas atingido antes da página terminal zero.");
}

const { count, error: countError } = await supabase
  .from("publication_items")
  .select("id", { count: "exact", head: true })
  .eq("pipeline_version", 2)
  .in("status", ["waiting", "ready"])
  .lt("execute_at", cutoff)
  .is("creation_id", null)
  .is("archived_at", null);
if (countError) throw new Error(`${countError.code ?? "COUNT_ERROR"}: ${countError.message}`);

process.stdout.write(`${JSON.stringify({ cutoff, reason, totalIgnored: total, remainingOverdueUnstarted: count, pages }, null, 2)}\n`);
