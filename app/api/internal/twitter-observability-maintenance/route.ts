import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isTwitterRolloutActive } from "@/lib/twitter/feature";
import { isTwitterWorkerAuthorized } from "@/lib/twitter/worker-auth";

export const dynamic = "force-dynamic";
const bucket = "twitter-log-archives";

export async function POST(request: Request) {
  if (!isTwitterWorkerAuthorized(request, "observability")) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  if (!isTwitterRolloutActive() || process.env.TWITTER_OBSERVABILITY_WORKER_ENABLED !== "true") return NextResponse.json({ skipped: true, reason: "worker_disabled" });
  const admin = createSupabaseAdminClient();
  const { error: partitionError } = await admin.rpc("twitter_ensure_observability_partitions", { p_months_ahead: 3 });
  if (partitionError) return NextResponse.json({ error: "Falha ao preparar partições de observabilidade X." }, { status: 500 });
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data: oldest, error: oldestError } = await admin.from("twitter_observability_events").select("organization_id,occurred_at").lt("occurred_at", cutoff).order("occurred_at").limit(1).maybeSingle();
  if (oldestError) return NextResponse.json({ error: "Falha ao localizar logs X expirados." }, { status: 500 });
  if (!oldest) return NextResponse.json({ ok: true, archived: 0, checkedAt: new Date().toISOString() });
  const start = new Date(oldest.occurred_at); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86_400_000);
  const rows: Record<string, unknown>[] = [], pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin.from("twitter_observability_events").select("*").eq("organization_id", oldest.organization_id).gte("occurred_at", start.toISOString()).lt("occurred_at", end.toISOString()).order("occurred_at").order("id").range(from, from + pageSize - 1);
    if (error) return NextResponse.json({ error: "Falha ao montar arquivo de logs X." }, { status: 500 });
    rows.push(...(data ?? [])); if ((data?.length ?? 0) < pageSize) break;
  }
  if (!rows.length) return NextResponse.json({ ok: true, archived: 0, checkedAt: new Date().toISOString() });
  const ndjson = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const compressed = gzipSync(Buffer.from(ndjson), { level: 9 });
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const day = start.toISOString().slice(0, 10), archiveId = randomUUID();
  const storagePath = `${oldest.organization_id}/${day}/${archiveId}.ndjson.gz`;
  const { error: uploadError } = await admin.storage.from(bucket).upload(storagePath, compressed, { contentType: "application/gzip", upsert: false });
  if (uploadError) return NextResponse.json({ error: "Falha ao armazenar arquivo privado de logs X." }, { status: 500 });
  const { data: manifest, error: manifestError } = await admin.from("twitter_observability_archives").insert({ id: archiveId, organization_id: oldest.organization_id, period_start: start.toISOString(), period_end: end.toISOString(), storage_path: storagePath, sha256, row_count: rows.length, byte_count: compressed.byteLength, status: "verified" }).select("id").single();
  if (manifestError || !manifest) return NextResponse.json({ error: "Arquivo criado, mas o manifesto X não pôde ser persistido." }, { status: 500 });
  const { data: removed, error: purgeError } = await admin.rpc("twitter_purge_archived_observability_events", { p_archive_id: manifest.id });
  if (purgeError) return NextResponse.json({ error: "Arquivo verificado, mas a partição quente não pôde ser limpa." }, { status: 500 });
  return NextResponse.json({ ok: true, archived: rows.length, removed: Number(removed ?? 0), periodStart: start.toISOString(), periodEnd: end.toISOString(), sha256, storagePath, checkedAt: new Date().toISOString() });
}
