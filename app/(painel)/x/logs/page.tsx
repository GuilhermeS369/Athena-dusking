import { notFound, redirect } from "next/navigation";

import { TwitterFinancialRules } from "@/app/x/twitter-financial-rules";
import { TwitterLogResolution } from "@/app/x/twitter-log-resolution";
import { getOrganizationContext } from "@/lib/organizations/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isTwitterModuleEnabled } from "@/lib/twitter/feature";

export const dynamic = "force-dynamic";
const usd = (micros: unknown) =>
  `US$ ${(Number(micros ?? 0) / 1e6).toFixed(3)}`;
const when = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
    : "—";

export default async function TwitterLogsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect("/login");
  if (!context.activeOrganization) redirect("/onboarding");
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient(),
    org = context.activeOrganization.id;
  const [
    operationsResult,
    analyticsResult,
    profilesResult,
    connectionsResult,
    holdsResult,
    reservationsResult,
    eventsResult,
    ledgerResult,
  ] = await Promise.all([
    admin
      .from("twitter_operation_logs")
      .select(
        "id,item_id,attempt_id,connection_id,profile_id,phase,http_status,provider_code,request_id,post_id,estimated_micros,settled_micros,message,metadata,created_at",
      )
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(500),
    admin
      .from("twitter_analytics_attempts")
      .select(
        "id,item_id,status,http_status,provider_code,request_id,error_message,evidence,started_at,finished_at",
      )
      .eq("organization_id", org)
      .order("started_at", { ascending: false })
      .limit(500),
    admin
      .from("twitter_profiles")
      .select("id,username")
      .eq("organization_id", org),
    admin
      .from("twitter_connections")
      .select("id,label")
      .eq("organization_id", org),
    admin
      .from("twitter_item_holds")
      .select(
        "item_id,reservation_id,status,amount_micros,activated_at,resolved_at",
      )
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(1000),
    admin
      .from("twitter_wallet_reservations")
      .select(
        "id,category,origin,status,initial_micros,remaining_micros,settled_micros,released_micros,outcome_unknown_at,resolved_at",
      )
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(1000),
    admin
      .from("twitter_reservation_events")
      .select(
        "id,reservation_id,event_type,amount_micros,reason,metadata,created_at",
      )
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(2000),
    admin
      .from("twitter_wallet_ledger")
      .select(
        "id,category,origin,entry_kind,delta_micros,source_id,metadata,created_at",
      )
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (
    operationsResult.error ||
    analyticsResult.error ||
    profilesResult.error ||
    connectionsResult.error ||
    holdsResult.error ||
    reservationsResult.error ||
    eventsResult.error ||
    ledgerResult.error
  )
    throw new Error(
      "Não foi possível carregar a timeline completa dos logs X.",
    );
  const operations = operationsResult.data ?? [],
    analytics = analyticsResult.data ?? [];
  const publicationIds = [
    ...new Set(
      operations
        .map((row) => row.item_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const analyticsIds = [...new Set(analytics.map((row) => row.item_id))];
  const publicationResult = publicationIds.length
    ? await admin
        .from("twitter_publication_items")
        .select("id,category,amount_micros")
        .eq("organization_id", org)
        .in("id", publicationIds)
    : { data: [], error: null };
  const analyticsItemsResult = analyticsIds.length
    ? await admin
        .from("twitter_analytics_items")
        .select("id,profile_id,connection_id,category,amount_micros,unit_cost_micros,reserved_units,settled_units,released_micros")
        .eq("organization_id", org)
        .in("id", analyticsIds)
    : { data: [], error: null };
  if (publicationResult.error || analyticsItemsResult.error)
    throw new Error("Não foi possível relacionar os logs X.");
  const profiles = new Map(
    (profilesResult.data ?? []).map((row) => [row.id, row.username]),
  );
  const connections = new Map(
    (connectionsResult.data ?? []).map((row) => [row.id, row.label]),
  );
  const items = new Map(
    (publicationResult.data ?? []).map((row) => [row.id, row]),
  );
  const analyticsItemMap = new Map(
    (analyticsItemsResult.data ?? []).map((row) => [row.id, row]),
  );
  const holds = new Map(
    (holdsResult.data ?? []).map((row) => [row.item_id, row]),
  );
  const reservations = new Map(
    (reservationsResult.data ?? []).map((row) => [row.id, row]),
  );
  const eventsByReservation = new Map<
    string,
    NonNullable<typeof eventsResult.data>
  >();
  for (const event of eventsResult.data ?? []) {
    const current = eventsByReservation.get(event.reservation_id) ?? [];
    current.push(event);
    eventsByReservation.set(event.reservation_id, current);
  }
  const canResolve = context.activeOrganization.role !== "viewer";
  const unknownCount=operations.filter(log=>log.phase==='outcome_unknown').length+analytics.filter(log=>log.status==='outcome_unknown').length;
  const openReservations=(reservationsResult.data??[]).filter(reservation=>Number(reservation.remaining_micros)>0).length;
  const settledTotal=operations.reduce((sum,log)=>sum+Number(log.settled_micros??0),0);
  return (
    <main className="standalone-page operation-page">
      <header className="standalone-header">
        <div>
          <span className="section-kicker">{context.activeOrganization.name} · X / Twitter</span>
          <h1>Status e logs</h1>
          <p>
            Timeline financeira e operacional exclusiva do X, construída somente
            com snapshots locais.
          </p>
        </div>
      </header>
      <section className="metric-grid"><article className="metric-card"><span className="metric-label">Eventos</span><strong>{operations.length+analytics.length}</strong><small className="metric-caption">Publicação e analytics</small></article><article className={unknownCount?'metric-card operation-metric-danger':'metric-card'}><span className="metric-label">Exigem atenção</span><strong>{unknownCount}</strong><small className="metric-caption">Resultados incertos</small></article><article className="metric-card"><span className="metric-label">Reservas abertas</span><strong>{openReservations}</strong><small className="metric-caption">Holds financeiros</small></article><article className="metric-card"><span className="metric-label">Liquidado</span><strong>{usd(settledTotal)}</strong><small className="metric-caption">Nos eventos carregados</small></article></section>
      {context.activeOrganization.role === "admin" ? (
        <TwitterFinancialRules />
      ) : null}
      <section className="content-stack">
        {operations.map((log) => {
          const item = log.item_id ? items.get(log.item_id) : null;
          const hold = log.item_id ? holds.get(log.item_id) : null;
          const reservation = hold
            ? reservations.get(hold.reservation_id)
            : null;
          const events = hold
            ? (eventsByReservation.get(hold.reservation_id) ?? [])
            : [];
          const relatedLedger = (ledgerResult.data ?? []).filter(
            (entry) =>
              entry.metadata?.itemId === log.item_id ||
              entry.source_id === hold?.reservation_id,
          );
          return (
            <article className="panel content-stack" key={log.id}>
              <div className="standalone-header">
                <div>
                  <h2>{log.phase}</h2>
                  <p>{log.message ?? "Sem mensagem"}</p>
                </div>
                <time>{when(log.created_at)}</time>
              </div>
              <div className="summary-grid">
                <div>
                  <span>Perfil</span>
                  <strong>
                    {log.profile_id
                      ? `@${profiles.get(log.profile_id) ?? "desconhecido"}`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Conexão</span>
                  <strong>
                    {log.connection_id
                      ? (connections.get(log.connection_id) ?? "desconhecida")
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Categoria</span>
                  <strong>
                    {item?.category ?? reservation?.category ?? "—"}
                  </strong>
                </div>
                <div>
                  <span>Estimado</span>
                  <strong>
                    {usd(log.estimated_micros ?? item?.amount_micros)}
                  </strong>
                </div>
                <div>
                  <span>Liquidado</span>
                  <strong>{usd(log.settled_micros)}</strong>
                </div>
                <div>
                  <span>HTTP / código</span>
                  <strong>
                    {log.http_status ?? "—"} / {log.provider_code ?? "—"}
                  </strong>
                </div>
                <div>
                  <span>Request ID</span>
                  <strong>{log.request_id ?? "—"}</strong>
                </div>
                <div>
                  <span>Post ID</span>
                  <strong>{log.post_id ?? "—"}</strong>
                </div>
              </div>
              {hold ? (
                <div className="summary-grid">
                  <div>
                    <span>Hold</span>
                    <strong>
                      {hold.status} · {usd(hold.amount_micros)}
                    </strong>
                  </div>
                  <div>
                    <span>Reserva</span>
                    <strong>{reservation?.status ?? "—"}</strong>
                  </div>
                  <div>
                    <span>Restante / liquidado / devolvido</span>
                    <strong>
                      {usd(reservation?.remaining_micros)} /{" "}
                      {usd(reservation?.settled_micros)} /{" "}
                      {usd(reservation?.released_micros)}
                    </strong>
                  </div>
                </div>
              ) : null}
              {events.length || relatedLedger.length ? (
                <details>
                  <summary>Timeline de reserva e ledger</summary>
                  {events.map((event) => (
                    <p key={event.id}>
                      {when(event.created_at)} · {event.event_type} ·{" "}
                      {usd(event.amount_micros)}
                      {event.reason ? ` · ${event.reason}` : ""}
                    </p>
                  ))}
                  {relatedLedger.map((entry) => (
                    <p key={entry.id}>
                      {when(entry.created_at)} · ledger {entry.entry_kind} ·{" "}
                      {usd(Math.abs(Number(entry.delta_micros)))}
                    </p>
                  ))}
                </details>
              ) : null}
              <details>
                <summary>Ver evidências</summary>
                <pre>{JSON.stringify(log.metadata ?? {}, null, 2)}</pre>
              </details>
              {log.phase === "outcome_unknown" &&
              log.attempt_id &&
              canResolve ? (
                <TwitterLogResolution attemptId={log.attempt_id} />
              ) : null}
            </article>
          );
        })}
        {analytics.map((log) => {
          const item = analyticsItemMap.get(log.item_id);
          return (
            <article className="panel content-stack" key={log.id}>
              <div className="standalone-header">
                <div>
                  <h2>analytics · {log.status}</h2>
                  <p>{log.error_message ?? "Leitura manual X"}</p>
                </div>
                <time>{when(log.started_at)}</time>
              </div>
              <div className="summary-grid">
                <div>
                  <span>Perfil</span>
                  <strong>
                    {item?.profile_id
                      ? `@${profiles.get(item.profile_id) ?? "desconhecido"}`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Conexão</span>
                  <strong>
                    {item?.connection_id
                      ? (connections.get(item.connection_id) ?? "desconhecida")
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Categoria / reserva máxima</span>
                  <strong>
                    {item?.category ?? "—"} · {usd(item?.amount_micros)}
                  </strong>
                </div>
                <div>
                  <span>HTTP / código</span>
                  <strong>
                    {log.http_status ?? "—"} / {log.provider_code ?? "—"}
                  </strong>
                </div>
                <div>
                  <span>Request ID</span>
                  <strong>{log.request_id ?? "—"}</strong>
                </div>
                <div>
                  <span>Finalização</span>
                  <strong>{when(log.finished_at)}</strong>
                </div>
              </div>
              <details>
                <summary>Ver evidências</summary>
                <pre>{JSON.stringify(log.evidence ?? {}, null, 2)}</pre>
              </details>
              {log.status === "outcome_unknown" && canResolve ? (
                <TwitterLogResolution
                  attemptId={log.id}
                  analytics
                  maxBilledUnits={item?.reserved_units ?? 1}
                />
              ) : null}
            </article>
          );
        })}
        {!(operations.length || analytics.length) ? (
          <div className="empty-state">
            <h2>Nenhum log X</h2>
          </div>
        ) : null}
      </section>
    </main>
  );
}
