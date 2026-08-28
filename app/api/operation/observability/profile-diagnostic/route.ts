import { NextResponse } from "next/server";

import {
  instagramPeriodDays,
  INSTAGRAM_FORMATS,
  isUuid,
} from "@/lib/instagram/observability";
import { getInstagramOperationContext } from "@/lib/instagram/request-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await getInstagramOperationContext();
  if ("response" in auth) return auth.response;
  const url = new URL(request.url),
    profileId = url.searchParams.get("profileId"),
    format = url.searchParams.get("format");
  if (!isUuid(profileId))
    return NextResponse.json({ error: "Perfil inválido." }, { status: 400 });
  if (format && !INSTAGRAM_FORMATS.includes(format as never))
    return NextResponse.json({ error: "Formato inválido." }, { status: 400 });
  const organizationId = auth.context.activeOrganization.id,
    admin = createSupabaseAdminClient();
  const cutoff = new Date(
    Date.now() -
      instagramPeriodDays(url.searchParams.get("period")) * 86_400_000,
  ).toISOString();
  let itemsQuery = admin
    .from("publication_items")
    .select(
      "id,batch_id,format,status,execute_at,attempt_count,next_attempt_at,published_at,last_error_code,last_error_message,created_at,updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId)
    .or(`created_at.gte.${cutoff},execute_at.gte.${cutoff}`)
    .order("execute_at", { ascending: false, nullsFirst: false })
    .limit(100);
  if (format) itemsQuery = itemsQuery.eq("format", format);
  const [itemsResult, planProfilesResult] = await Promise.all([
    itemsQuery,
    admin
      .from("bulk_publication_plan_profiles")
      .select(
        "plan_id,status,first_execute_at,last_execute_at,total_slot_count,next_slot_index,generated_slot_count,failed_slot_count,suspension_reason",
      )
      .eq("organization_id", organizationId)
      .eq("profile_id", profileId)
      .gte("last_execute_at", cutoff)
      .order("last_execute_at", { ascending: false })
      .limit(50),
  ]);
  if (itemsResult.error || planProfilesResult.error)
    return NextResponse.json(
      { error: "Não foi possível montar o diagnóstico do perfil." },
      { status: 500 },
    );
  const planIds = (planProfilesResult.data ?? []).map((row) => row.plan_id);
  const { data: plans, error: plansError } = planIds.length
    ? await admin
        .from("bulk_publication_plans")
        .select("id,name,format,status,origin_group_id")
        .in("id", planIds)
    : { data: [], error: null };
  if (plansError)
    return NextResponse.json(
      { error: "Não foi possível verificar a programação do perfil." },
      { status: 500 },
    );
  const planById = new Map((plans ?? []).map((row) => [row.id, row]));
  const relevantPlanProfiles = (planProfilesResult.data ?? []).filter(
    (row) => !format || planById.get(row.plan_id)?.format === format,
  );
  const items = itemsResult.data ?? [],
    counts: Record<string, number> = {};
  for (const item of items)
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  const now = Date.now(),
    duePlans = relevantPlanProfiles.filter(
      (row) => new Date(row.first_execute_at).getTime() <= now,
    );
  let state = "healthy",
    title = "A programação possui eventos no período.",
    explanation = "Use a linha do tempo abaixo para acompanhar cada etapa.";
  if (!items.length && !relevantPlanProfiles.length) {
    state = "no_schedule";
    title = "Nenhuma publicação foi agendada neste período.";
    explanation =
      "Não existe item nem plano ativo para este perfil e formato no recorte escolhido.";
  } else if (!items.length && duePlans.length) {
    state = "materialization_gap";
    title = "Havia programação, mas nenhum item foi materializado.";
    explanation =
      "O plano alcançou o horário esperado sem criar a unidade de publicação na fila.";
  } else if (!items.length) {
    state = "scheduled_not_due";
    title = "Existe uma programação futura, ainda não materializada.";
    explanation = "O primeiro horário do plano ainda não venceu.";
  } else if ((counts.failed ?? 0) > 0) {
    const retrying = items.filter(
      (item) => item.status === "failed" && item.next_attempt_at,
    ).length;
    state = retrying ? "retrying" : "failed";
    title = retrying
      ? "Há falhas com nova tentativa programada."
      : "Há falhas que exigem atenção.";
    explanation = retrying
      ? `${retrying} publicação(ões) estão sob recuperação automática.`
      : "Abra os eventos de erro abaixo para ver código, provedor e contramedida.";
  } else if ((counts.preparing ?? 0) + (counts.publishing ?? 0) > 0) {
    state = "in_progress";
    title = "A publicação está em processamento.";
    explanation =
      "O worker já capturou o item e aguarda o resultado do provedor.";
  } else if ((counts.waiting ?? 0) + (counts.ready ?? 0) > 0) {
    const overdue = items.filter(
      (item) =>
        ["waiting", "ready"].includes(item.status) &&
        item.execute_at &&
        new Date(item.execute_at).getTime() < now,
    ).length;
    state = overdue ? "not_claimed" : "scheduled";
    title = overdue
      ? "Há item vencido que ainda não foi capturado."
      : "A publicação está agendada e ainda não venceu.";
    explanation = overdue
      ? `${overdue} item(ns) passaram do horário sem início de processamento.`
      : "A linha do tempo será atualizada quando o worker capturar o item.";
  } else if ((counts.published ?? 0) > 0) {
    state = "published";
    title = "O provedor confirmou a publicação.";
    explanation =
      format === "story"
        ? "Se o Story tem mais de 24 horas, é normal que já não esteja visível no Instagram."
        : "A publicação terminou com sucesso.";
  } else if ((counts.ignored ?? 0) + (counts.suspended ?? 0) > 0) {
    state = "contained";
    title = "A publicação foi contida por uma contramedida.";
    explanation =
      "O sistema impediu envio inseguro ou fora da janela planejada.";
  }
  const canInspect = auth.context.activeOrganization.role !== "viewer";
  return NextResponse.json({
    state,
    title,
    explanation,
    counts,
    itemCount: items.length,
    planCount: relevantPlanProfiles.length,
    latestItems: items
      .slice(0, 10)
      .map((item) => ({
        ...item,
        last_error_message: canInspect ? item.last_error_message : null,
      })),
    plans: relevantPlanProfiles
      .slice(0, 10)
      .map((row) => ({ ...row, ...planById.get(row.plan_id) })),
    checkedAt: new Date().toISOString(),
  });
}
