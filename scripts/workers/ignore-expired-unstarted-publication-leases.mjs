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
const expected = Number(option("expected"));
const reason = option("reason") ?? "operator_expired_unstarted_lease_cleanup";
if (!cutoff || Number.isNaN(Date.parse(cutoff))) throw new Error("Use --cutoff ISO válido.");
if (!Number.isInteger(expected) || expected < 1 || expected > 100) throw new Error("Use --expected entre 1 e 100.");

const supabase = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data, error } = await supabase.rpc("ignore_expired_unstarted_publication_leases", {
  p_before: cutoff,
  p_expected: expected,
  p_reason: reason,
});
if (error) throw new Error(`${error.code ?? "RPC_ERROR"}: ${error.message}`);
process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
