import { after, NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function instagramObservedJson(
  startedAt: number,
  organizationId: string,
  route: string,
  body: unknown,
  status = 200,
  stages: Record<string, number> = {},
) {
  const serialized = JSON.stringify(body);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  const normalizedStages = Object.fromEntries(
    Object.entries(stages)
      .filter(([name, value]) => /^[a-z][a-z0-9_]{0,39}$/.test(name) && Number.isFinite(value))
      .map(([name, value]) => [name, Math.max(0, Math.round(value))]),
  );
  after(async () => {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.rpc("instagram_record_observability_api_metric", {
      p_organization_id: organizationId,
      p_route: route,
      p_status_code: status,
      p_duration_ms: durationMs,
      p_payload_bytes: payloadBytes,
      p_stage_durations: normalizedStages,
    });
    if (error)
      console.warn("instagram_api_metric_failed", {
        route,
        error: error.message,
      });
  });
  const serverTiming = [
    `app;dur=${durationMs}`,
    ...Object.entries(normalizedStages).map(
      ([name, value]) => `${name};dur=${value}`,
    ),
  ].join(", ");
  return new NextResponse(serialized, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "server-timing": serverTiming,
      "x-observability-payload-bytes": String(payloadBytes),
    },
  });
}
