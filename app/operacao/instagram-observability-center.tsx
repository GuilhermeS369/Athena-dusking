"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import styles from "./instagram-observability-center.module.css";

type DispatchState = {
  preloaded: number;
  awaitingQuota: number;
  sentToProvider: number;
  profileDisconnected: number;
  due: number;
  failuresLastHour: number;
  publishedLastMinute: number;
  oldestDueAgeSeconds: number;
  activeTotal: number;
  backlogStalled: boolean;
  lastProgressAt: string | null;
  generatedAt: string | null;
  stale: boolean;
};
type Summary = {
  incidents?: Record<string, number>;
  events24h?: number;
  workers?: Record<string, number>;
  queue?: Record<string, number>;
  dispatch?: DispatchState | null;
};
type Entity = {
  id: string;
  username?: string;
  display_name?: string | null;
  provider?: string;
  name?: string;
  profileCount?: number;
};
type EventRow = {
  id: string;
  occurred_at: string;
  domain: string;
  severity: string;
  treatment_state: string;
  stable_code: string;
  provider?: string | null;
  publication_format?: string | null;
  message: string;
  countermeasure?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  profile?: { username: string; display_name?: string | null } | null;
  sourceGroupName?: string | null;
  connectionLabel?: string | null;
  http_status?: number | null;
  request_id?: string | null;
  post_id?: string | null;
};
type Incident = {
  id: string;
  domain: string;
  severity: string;
  treatment_state: string;
  title: string;
  stable_code: string;
  last_seen_at: string;
  occurrence_count: number;
  affected_profile_count: number;
  latest_countermeasure?: Record<string, unknown>;
  availableActions: Array<"investigate" | "resolve">;
};
type IncidentDetails = {
  incident: Incident & { first_seen_at: string; stage: string; provider?: string | null };
  occurrences: Array<EventRow & { source_status?: string | null }>;
  profiles: Array<{ profile_id: string; occurrence_count: number; profile?: Entity | null }>;
  entities: Array<{ entity_type: string; entity_id: string; state: string; occurrence_count: number }>;
  actions: Array<{ id: string; previous_treatment: string; treatment_state: string; justification: string; fix_reference?: string | null; actor_email?: string | null; created_at: string }>;
};
type Worker = {
  workerKind: string;
  status: string;
  lastSeenAt?: string | null;
  lastErrorMessage?: string | null;
  hostname?: string | null;
  processId?: number | null;
  version?: string | null;
};
type ProfileDiagnostic = {
  state: string;
  title: string;
  explanation: string;
  counts: Record<string, number>;
  itemCount: number;
  planCount: number;
};

const scopes = [
  ["activity", "Tudo"],
  ["publication", "Publicações"],
  ["connection", "Conexões"],
  ["scheduling", "Agenda"],
  ["worker", "Workers"],
  ["account", "Contas"],
  ["analytics", "Analytics"],
  ["media", "Mídia"],
] as const;
const treatmentLabels: Record<string, string> = {
  action_required: "Ação necessária",
  investigating: "Investigando",
  auto_recovering: "Recuperação automática",
  contained: "Contido",
  resolved: "Resolvido",
};
const domainLabels: Record<string, string> = {
  account: "Conta",
  scheduling: "Agenda",
  publication: "Publicação",
  worker: "Worker",
  connection: "Conexão",
  analytics: "Analytics",
  media: "Mídia",
};
const workerLabels: Record<string, string> = {
  publication: "Publicação",
  publication_planner: "Planejamento",
  media_deletion: "Limpeza de mídia",
  profile_analytics: "Analytics",
  zernio_sync: "Sincronização Zernio",
};

function relativeTime(value?: string | null) {
  if (!value) return "nunca";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000),
    absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600)
    return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400)
    return formatter.format(Math.round(seconds / 3600), "hour");
  return formatter.format(Math.round(seconds / 86400), "day");
}
function exactTime(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}
function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error ?? "Não foi possível concluir a operação.");
  return body as T;
}

export default function InstagramObservabilityCenter({
  organizationName,
  role,
  isSuperUser,
}: {
  organizationName: string;
  role: string;
  isSuperUser: boolean;
}) {
  const searchParams = useSearchParams();
  const initialScope = scopes.some(
    ([value]) => value === searchParams.get("scope"),
  )
    ? searchParams.get("scope")!
    : "activity";
  const fromUrl = (key: string, fallback = "") => searchParams.get(key) ?? fallback;
  const [scope, setScope] = useState(initialScope),
    [period, setPeriod] = useState(fromUrl("period", "24h")),
    [format, setFormat] = useState(fromUrl("format")),
    [provider, setProvider] = useState(fromUrl("provider")),
    [severity, setSeverity] = useState(fromUrl("severity")),
    [treatment, setTreatment] = useState(fromUrl("treatment")),
    [sourceStatus, setSourceStatus] = useState(fromUrl("status")),
    [workerKind, setWorkerKind] = useState(fromUrl("worker")),
    [connection, setConnection] = useState(fromUrl("connection")),
    [batchId, setBatchId] = useState(fromUrl("batchId")),
    [search, setSearch] = useState(fromUrl("q"));
  const [entityType, setEntityType] = useState<"profile" | "group">("profile"),
    [entityQuery, setEntityQuery] = useState(""),
    [entityOptions, setEntityOptions] = useState<Entity[]>([]),
    [selectedEntity, setSelectedEntity] = useState<Entity | null>(null),
    [groupMode, setGroupMode] = useState<"origin" | "current">("origin");
  const [summary, setSummary] = useState<Summary | null>(null),
    [events, setEvents] = useState<EventRow[]>([]),
    [incidents, setIncidents] = useState<Incident[]>([]),
    [workers, setWorkers] = useState<Worker[]>([]),
    [profileDiagnostic, setProfileDiagnostic] =
      useState<ProfileDiagnostic | null>(null),
    [nextCursor, setNextCursor] = useState<string | null>(null),
    [clearedAt, setClearedAt] = useState<string | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null),
    [incidentDetails, setIncidentDetails] = useState<IncidentDetails | null>(null),
    [detailsLoading, setDetailsLoading] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [refreshing, setRefreshing] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ scope, period, limit: "50" });
    if (format) params.set("format", format);
    if (provider) params.set("provider", provider);
    if (severity) params.set("severity", severity);
    if (treatment) params.set("treatment", treatment);
    if (sourceStatus) params.set("status", sourceStatus);
    if (workerKind) params.set("worker", workerKind);
    if (connection.trim()) params.set("connection", connection.trim());
    if (looksLikeUuid(batchId.trim())) params.set("batchId", batchId.trim());
    if (search.trim()) params.set("q", search.trim());
    if (selectedEntity)
      params.set(
        entityType === "profile" ? "profileId" : "groupId",
        selectedEntity.id,
      );
    if (selectedEntity && entityType === "group")
      params.set("groupMode", groupMode);
    return params.toString();
  }, [
    scope,
    period,
    format,
    provider,
    severity,
    treatment,
    sourceStatus,
    workerKind,
    connection,
    batchId,
    search,
    selectedEntity,
    entityType,
    groupMode,
  ]);

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const incidentParams = new URLSearchParams({ limit: "30", scope });
        if (selectedEntity && entityType === "profile")
          incidentParams.set("profileId", selectedEntity.id);
        if (selectedEntity && entityType === "group") {
          incidentParams.set("groupId", selectedEntity.id);
          incidentParams.set("groupMode", groupMode);
        }
        if (severity) incidentParams.set("severity", severity);
        if (treatment) incidentParams.set("treatment", treatment);
        if (search.trim()) incidentParams.set("q", search.trim());
        const failures: string[] = [];

        const [summaryResult, eventsResult] = await Promise.allSettled([
          readJson<Summary>("/api/operation/observability/summary"),
          readJson<{
            events: EventRow[];
            nextCursor: string | null;
            clearedAt: string | null;
          }>(`/api/operation/observability/events?${queryString}`),
        ]);

        if (summaryResult.status === "fulfilled") setSummary(summaryResult.value);
        else failures.push("resumo");
        if (eventsResult.status === "fulfilled") {
          setEvents(eventsResult.value.events);
          setNextCursor(eventsResult.value.nextCursor);
          setClearedAt(eventsResult.value.clearedAt);
        } else failures.push("linha do tempo");

        // Libera a parte principal da tela sem esperar os painéis administrativos.
        if (!silent) setLoading(false);
        if (failures.length)
          setError(
            `Falha parcial em: ${failures.join(", ")}. Os demais dados continuam disponíveis.`,
          );

        // Atualizações automáticas mantêm a timeline viva sem repetir os painéis
        // administrativos a cada ciclo. O botão Atualizar continua recarregando tudo.
        if (silent) return;

        const [incidentsResult, workersResult] = await Promise.allSettled([
          readJson<{ incidents: Incident[] }>(
            `/api/operation/observability/incidents?${incidentParams}`,
          ),
          readJson<{ workers: Worker[] }>(
            "/api/operation/observability/workers",
          ),
        ]);

        if (incidentsResult.status === "fulfilled") setIncidents(incidentsResult.value.incidents);
        else failures.push("incidentes");
        if (workersResult.status === "fulfilled") setWorkers(workersResult.value.workers);
        else failures.push("workers");
        if (failures.length) setError(`Falha parcial em: ${failures.join(", ")}. Os demais dados continuam disponíveis.`);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Falha inesperada.",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [queryString, selectedEntity, entityType, severity, treatment, search, scope, groupMode],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!selectedIncident) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedIncident(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedIncident]);
  useEffect(() => {
    const url = `${window.location.pathname}?${queryString}`;
    window.history.replaceState(null, "", url);
  }, [queryString]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 120_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!selectedEntity || entityType !== "profile") {
      setProfileDiagnostic(null);
      return;
    }
    const params = new URLSearchParams({
      profileId: selectedEntity.id,
      period,
    });
    if (format) params.set("format", format);
    void readJson<ProfileDiagnostic>(
      `/api/operation/observability/profile-diagnostic?${params}`,
    )
      .then(setProfileDiagnostic)
      .catch(() => setProfileDiagnostic(null));
  }, [selectedEntity, entityType, period, format]);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!entityQuery.trim()) {
      setEntityOptions([]);
      return;
    }
    searchTimer.current = setTimeout(
      () =>
        void readJson<{ options: Entity[] }>(
          `/api/operation/observability/entities?type=${entityType}&q=${encodeURIComponent(entityQuery)}`,
        )
          .then((body) => setEntityOptions(body.options))
          .catch(() => setEntityOptions([])),
      250,
    );
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [entityQuery, entityType]);

  async function loadMore() {
    if (!nextCursor) return;
    try {
      const body = await readJson<{
        events: EventRow[];
        nextCursor: string | null;
      }>(
        `/api/operation/observability/events?${queryString}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setEvents((current) => [...current, ...body.events]);
      setNextCursor(body.nextCursor);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível carregar mais eventos.",
      );
    }
  }
  async function updateVisibility(action: "clear" | "undo") {
    await readJson("/api/operation/observability/visibility", {
      method: "POST",
      body: JSON.stringify({ scope, action }),
    });
    await load(true);
  }
  async function updateIncident(
    incident: Incident,
    next: "investigating" | "resolved",
  ) {
    const justification = window.prompt(
      next === "resolved"
        ? "Como este incidente foi resolvido?"
        : "O que será investigado?",
    );
    if (!justification) return;
    try {
      await readJson(
        `/api/operation/observability/incidents/${incident.id}/status`,
        {
          method: "POST",
          body: JSON.stringify({ treatment: next, justification }),
        },
      );
      await load(true);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível atualizar o incidente.",
      );
    }
  }
  async function openIncident(incident: Incident) {
    setSelectedIncident(incident);
    setIncidentDetails(null);
    setDetailsLoading(true);
    try {
      setIncidentDetails(
        await readJson<IncidentDetails>(
          `/api/operation/observability/incidents/${incident.id}`,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível abrir o incidente.");
    } finally {
      setDetailsLoading(false);
    }
  }

  const filteredTitle = selectedEntity
    ? entityType === "profile"
      ? `@${selectedEntity.username}`
      : selectedEntity.name
    : "Todos os perfis";
  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <div>
          <div className={styles.eyebrow}>
            <span className={styles.liveDot} /> Central de observabilidade ·{" "}
            {organizationName}
          </div>
          <h1>Operação Instagram</h1>
          <p>
            Descubra o que aconteceu, qual contramedida já entrou em ação e onde
            você precisa intervir.
          </p>
        </div>
        <div className={styles.heroActions}>
          <span className={styles.retention}>Histórico de 14 dias</span>
          <button
            className={styles.refreshButton}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </header>
      {error && (
        <div className={styles.errorBanner}>
          <span>{error}</span>
          <button onClick={() => setError(null)}>Fechar</button>
        </div>
      )}
      <section className={styles.metrics} aria-label="Resumo operacional">
        <article className={`${styles.metric} ${styles.metricDanger}`}>
          <span>Ação necessária</span>
          <strong>{summary?.incidents?.actionRequired ?? "—"}</strong>
          <small>{summary?.incidents?.critical ?? 0} críticos agora</small>
        </article>
        <article className={styles.metric}>
          <span>Em recuperação</span>
          <strong>{summary?.incidents?.autoRecovering ?? "—"}</strong>
          <small>Erros com contramedida ativa</small>
        </article>
        <article className={styles.metric}>
          <span>Fila ativa</span>
          <strong>{summary?.queue?.active ?? "—"}</strong>
          <small>
            {summary?.queue?.overdue ?? 0} atrasados ·{" "}
            {summary?.queue?.retries ?? 0} retries
          </small>
        </article>
        <article className={styles.metric}>
          <span>Workers saudáveis</span>
          <strong>
            {summary?.workers?.active ?? "—"}
            <em>/{summary?.workers?.expected ?? 5}</em>
          </strong>
          <small>{summary?.workers?.stale ?? 0} offline ou atrasados</small>
        </article>
        <article className={styles.metric}>
          <span>Eventos em 24h</span>
          <strong>{summary?.events24h ?? "—"}</strong>
          <small>
            {summary?.incidents?.affectedProfiles ?? 0} perfis afetados
          </small>
        </article>
      </section>
      <section className={styles.metrics} aria-label="Estado do despacho">
        <article className={styles.metric}>
          <span>Pré-carregado</span>
          <strong>{summary?.dispatch?.preloaded ?? "—"}</strong>
          <small>{summary?.dispatch?.due ?? 0} já vencidos</small>
        </article>
        <article className={styles.metric}>
          <span>Aguardando cota</span>
          <strong>{summary?.dispatch?.awaitingQuota ?? "—"}</strong>
          <small>Adiados por limite de despacho</small>
        </article>
        <article className={styles.metric}>
          <span>Enviado ao provedor</span>
          <strong>{summary?.dispatch?.sentToProvider ?? "—"}</strong>
          <small>{summary?.dispatch?.publishedLastMinute ?? 0} publicados no último minuto</small>
        </article>
        <article className={styles.metric}>
          <span>Perfis desconectados</span>
          <strong>{summary?.dispatch?.profileDisconnected ?? "—"}</strong>
          <small>{summary?.dispatch?.failuresLastHour ?? 0} falhas na última hora</small>
        </article>
        <article
          className={
            summary?.dispatch?.backlogStalled
              ? `${styles.metric} ${styles.metricDanger}`
              : styles.metric
          }
        >
          <span>Backlog</span>
          <strong>
            {summary?.dispatch?.backlogStalled ? "Parado" : "Avançando"}
          </strong>
          <small>
            {summary?.dispatch?.activeTotal ?? 0} ativos · item mais antigo{" "}
            {summary?.dispatch?.oldestDueAgeSeconds
              ? `${Math.round(summary.dispatch.oldestDueAgeSeconds / 60)} min`
              : "0 min"}{" "}
            vencido
          </small>
        </article>
      </section>
      <section className={styles.workspace}>
        <div className={styles.toolbar}>
          <nav className={styles.scopeTabs}>
            {scopes.map(([value, label]) => (
              <button
                key={value}
                className={scope === value ? styles.activeTab : ""}
                onClick={() => setScope(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className={styles.contextSearch}>
            <div className={styles.segmented}>
              <button
                className={
                  entityType === "profile" ? styles.selectedSegment : ""
                }
                onClick={() => {
                  setEntityType("profile");
                  setSelectedEntity(null);
                }}
              >
                Perfil
              </button>
              <button
                className={entityType === "group" ? styles.selectedSegment : ""}
                onClick={() => {
                  setEntityType("group");
                  setSelectedEntity(null);
                }}
              >
                Grupo
              </button>
            </div>
            <div className={styles.entityInputWrap}>
              <input
                value={entityQuery}
                onChange={(event) => setEntityQuery(event.target.value)}
                placeholder={
                  entityType === "profile"
                    ? "Buscar por @ ou nome…"
                    : "Buscar grupo…"
                }
              />
              {entityOptions.length > 0 && (
                <div className={styles.suggestions}>
                  {entityOptions.map((option) => (
                    <button
                      key={option.id}
                      onClick={() => {
                        setSelectedEntity(option);
                        setEntityOptions([]);
                        setEntityQuery(
                          entityType === "profile"
                            ? `@${option.username}`
                            : (option.name ?? ""),
                        );
                      }}
                    >
                      <strong>
                        {entityType === "profile"
                          ? `@${option.username}`
                          : option.name}
                      </strong>
                      <span>
                        {entityType === "profile"
                          ? option.display_name || option.provider
                          : `${option.profileCount ?? 0} perfis`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className={styles.filters}>
            <label>
              <span>Buscar nos logs</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Erro, código, request…"
              />
            </label>
            <label>
              <span>Período</span>
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
              >
                <option value="24h">24 horas</option>
                <option value="3d">3 dias</option>
                <option value="7d">7 dias</option>
                <option value="14d">14 dias</option>
              </select>
            </label>
            <label>
              <span>Formato</span>
              <select
                value={format}
                onChange={(event) => setFormat(event.target.value)}
              >
                <option value="">Todos</option>
                <option value="story">Story</option>
                <option value="reel">Reel</option>
                <option value="image">Imagem</option>
                <option value="carousel">Carrossel</option>
              </select>
            </label>
            <label>
              <span>Provedor</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="">Todos</option>
                <option value="meta_official">Meta oficial</option>
                <option value="zernio">Zernio</option>
              </select>
            </label>
            <label>
              <span>Severidade</span>
              <select
                value={severity}
                onChange={(event) => setSeverity(event.target.value)}
              >
                <option value="">Todas</option>
                <option value="critical">Crítica</option>
                <option value="error">Erro</option>
                <option value="warning">Aviso</option>
                <option value="info">Informação</option>
              </select>
            </label>
            <label>
              <span>Tratamento</span>
              <select value={treatment} onChange={(event) => setTreatment(event.target.value)}>
                <option value="">Ativos</option>
                <option value="action_required">Ação necessária</option>
                <option value="investigating">Investigando</option>
                <option value="auto_recovering">Recuperação automática</option>
                <option value="contained">Contido</option>
                <option value="resolved">Resolvido</option>
              </select>
            </label>
            <label>
              <span>Status da origem</span>
              <input value={sourceStatus} onChange={(event) => setSourceStatus(event.target.value)} placeholder="failed, queued…" />
            </label>
            <label>
              <span>Worker/job</span>
              <select value={workerKind} onChange={(event) => setWorkerKind(event.target.value)}>
                <option value="">Todos</option>
                {Object.entries(workerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>Conexão</span>
              <input value={connection} onChange={(event) => setConnection(event.target.value)} placeholder="Nome ou ID…" />
            </label>
            <label>
              <span>Lote</span>
              <input value={batchId} onChange={(event) => setBatchId(event.target.value)} placeholder="UUID do lote…" />
            </label>
            <button
              className={styles.clearFilters}
              onClick={() => {
                setFormat(""); setProvider(""); setSeverity(""); setTreatment("");
                setSourceStatus(""); setWorkerKind(""); setConnection(""); setBatchId(""); setSearch("");
              }}
            >
              Limpar filtros
            </button>
          </div>
        </div>
        {selectedEntity && (
          <div className={styles.contextBanner}>
            <div>
              <span>Investigando</span>
              <strong>{filteredTitle}</strong>
              <small>
                {entityType === "profile"
                  ? selectedEntity.display_name || selectedEntity.provider
                  : `${selectedEntity.profileCount ?? 0} perfis no grupo`}
              </small>
            </div>
            {entityType === "group" && (
              <div className={styles.groupMode}>
                <button
                  className={groupMode === "origin" ? styles.modeActive : ""}
                  onClick={() => setGroupMode("origin")}
                >
                  Grupo de origem
                </button>
                <button
                  className={groupMode === "current" ? styles.modeActive : ""}
                  onClick={() => setGroupMode("current")}
                >
                  Membros atuais
                </button>
              </div>
            )}
            <button
              className={styles.clearContext}
              onClick={() => {
                setSelectedEntity(null);
                setEntityQuery("");
              }}
            >
              Remover filtro
            </button>
          </div>
        )}
        {selectedEntity && entityType === "profile" && profileDiagnostic && (
          <section
            className={`${styles.diagnostic} ${styles[profileDiagnostic.state] ?? ""}`}
          >
            <div className={styles.diagnosticIcon} aria-hidden="true">
              {profileDiagnostic.state === "published"
                ? "✓"
                : profileDiagnostic.state === "no_schedule"
                  ? "○"
                  : "!"}
            </div>
            <div>
              <span>Diagnóstico do período{format ? ` · ${format}` : ""}</span>
              <strong>{profileDiagnostic.title}</strong>
              <p>{profileDiagnostic.explanation}</p>
            </div>
            <dl>
              <div>
                <dt>Itens</dt>
                <dd>{profileDiagnostic.itemCount}</dd>
              </div>
              <div>
                <dt>Planos</dt>
                <dd>{profileDiagnostic.planCount}</dd>
              </div>
              <div>
                <dt>Publicados</dt>
                <dd>{profileDiagnostic.counts.published ?? 0}</dd>
              </div>
              <div>
                <dt>Falhas</dt>
                <dd>{profileDiagnostic.counts.failed ?? 0}</dd>
              </div>
            </dl>
          </section>
        )}
        <div className={styles.contentGrid}>
          <aside className={styles.incidentPanel}>
            <div className={styles.panelHeader}>
              <div>
                <span>Prioridade</span>
                <h2>Incidentes ativos</h2>
              </div>
              <span className={styles.count}>{incidents.length}</span>
            </div>
            <div className={styles.incidentList}>
              {incidents.length ? (
                incidents.map((incident) => (
                  <article
                    key={incident.id}
                    className={`${styles.incidentCard} ${styles[incident.severity] ?? ""}`}
                  >
                    <div className={styles.cardTop}>
                      <span className={styles.severity}>
                        {incident.severity}
                      </span>
                      <time title={exactTime(incident.last_seen_at)}>
                        {relativeTime(incident.last_seen_at)}
                      </time>
                    </div>
                    <h3>{incident.title}</h3>
                    <code>{incident.stable_code}</code>
                    <div className={styles.incidentMeta}>
                      <span>
                        {domainLabels[incident.domain] ?? incident.domain}
                      </span>
                      <span>{incident.occurrence_count} ocorrências</span>
                      <span>{incident.affected_profile_count} perfis</span>
                    </div>
                    <div
                      className={`${styles.treatment} ${styles[incident.treatment_state] ?? ""}`}
                    >
                      <span>{treatmentLabels[incident.treatment_state]}</span>
                      {Boolean(incident.latest_countermeasure?.kind) && (
                        <small>
                          {String(
                            incident.latest_countermeasure?.kind,
                          ).replaceAll("_", " ")}
                        </small>
                      )}
                    </div>
                    {role !== "viewer" && (
                      <div className={styles.incidentActions}>
                        <button onClick={() => void openIncident(incident)}>Ver detalhes</button>
                        {incident.availableActions.includes("investigate") && (
                          <button
                            onClick={() =>
                              void updateIncident(incident, "investigating")
                            }
                          >
                            Investigar
                          </button>
                        )}
                        {incident.availableActions.includes("resolve") && (
                          <button onClick={() => void updateIncident(incident, "resolved")}>
                            Marcar resolvido
                          </button>
                        )}
                      </div>
                    )}
                    {role === "viewer" && (
                      <button className={styles.detailsButton} onClick={() => void openIncident(incident)}>Ver detalhes</button>
                    )}
                  </article>
                ))
              ) : (
                <div className={styles.emptyState}>
                  <span>✓</span>
                  <strong>Nenhum incidente neste recorte</strong>
                  <p>Os eventos informativos continuam na linha do tempo.</p>
                </div>
              )}
            </div>
          </aside>
          <section className={styles.timelinePanel}>
            <div className={styles.panelHeader}>
              <div>
                <span>Linha do tempo</span>
                <h2>{filteredTitle}</h2>
              </div>
              <div className={styles.timelineActions}>
                {clearedAt ? (
                  <button onClick={() => void updateVisibility("undo")}>
                    Desfazer limpeza
                  </button>
                ) : (
                  <button onClick={() => void updateVisibility("clear")}>
                    Limpar visualização
                  </button>
                )}
              </div>
            </div>
            {entityType === "profile" &&
              selectedEntity &&
              format === "story" && (
                <div className={styles.storyHint}>
                  <strong>Diagnóstico de Story ativo</strong>
                  <span>
                    A sequência mostra agendamento, captura pelo worker, envio e
                    resultado. Um Story publicado há mais de 24h pode ter
                    expirado normalmente.
                  </span>
                </div>
              )}
            <div className={styles.timeline}>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className={styles.skeleton} />
                ))
              ) : events.length ? (
                events.map((event) => (
                  <article
                    key={`${event.occurred_at}-${event.id}`}
                    className={styles.event}
                  >
                    <div
                      className={`${styles.eventMarker} ${styles[event.severity] ?? ""}`}
                    />
                    <div className={styles.eventBody}>
                      <div className={styles.eventTop}>
                        <div>
                          <span className={styles.domain}>
                            {domainLabels[event.domain] ?? event.domain}
                          </span>
                          {event.publication_format && (
                            <span className={styles.format}>
                              {event.publication_format}
                            </span>
                          )}
                          {event.provider && (
                            <span className={styles.provider}>
                              {event.provider === "meta_official"
                                ? "Meta"
                                : event.provider}
                            </span>
                          )}
                        </div>
                        <time title={exactTime(event.occurred_at)}>
                          {relativeTime(event.occurred_at)}
                        </time>
                      </div>
                      <h3>{event.message}</h3>
                      <div className={styles.eventIdentity}>
                        {event.profile && (
                          <strong>@{event.profile.username}</strong>
                        )}
                        {event.sourceGroupName && (
                          <span>Origem: {event.sourceGroupName}</span>
                        )}
                        {event.connectionLabel && (
                          <span>{event.connectionLabel}</span>
                        )}
                        <code>{event.stable_code}</code>
                      </div>
                      <div className={styles.eventStatus}>
                        <span className={styles[event.treatment_state] ?? ""}>
                          {treatmentLabels[event.treatment_state] ??
                            event.treatment_state}
                        </span>
                        {Boolean(event.countermeasure?.nextAttemptAt) && (
                          <small>
                            Próxima tentativa{" "}
                            {relativeTime(
                              String(event.countermeasure?.nextAttemptAt),
                            )}
                          </small>
                        )}
                        {event.http_status && (
                          <small>HTTP {event.http_status}</small>
                        )}
                      </div>
                      {(event.request_id ||
                        event.post_id ||
                        (event.evidence &&
                          Object.keys(event.evidence).length > 0 &&
                          role !== "viewer")) && (
                        <details>
                          <summary>Detalhes técnicos</summary>
                          <dl>
                            {event.request_id && (
                              <>
                                <dt>Request</dt>
                                <dd>{event.request_id}</dd>
                              </>
                            )}
                            {event.post_id && (
                              <>
                                <dt>Post</dt>
                                <dd>{event.post_id}</dd>
                              </>
                            )}
                            {event.evidence &&
                              Object.entries(event.evidence)
                                .slice(0, 8)
                                .map(([key, value]) => (
                                  <span key={key}>
                                    <dt>{key}</dt>
                                    <dd>
                                      {typeof value === "object"
                                        ? JSON.stringify(value)
                                        : String(value)}
                                    </dd>
                                  </span>
                                ))}
                          </dl>
                        </details>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <div className={styles.emptyState}>
                  <span>⌁</span>
                  <strong>Nenhum evento encontrado</strong>
                  <p>
                    Amplie o período ou remova algum filtro. A retenção máxima é
                    de 14 dias.
                  </p>
                </div>
              )}
            </div>
            {nextCursor && (
              <button
                className={styles.loadMore}
                onClick={() => void loadMore()}
              >
                Carregar eventos anteriores
              </button>
            )}
          </section>
        </div>
        {(scope === "worker" || isSuperUser) && (
          <section className={styles.workerSection}>
            <div className={styles.panelHeader}>
              <div>
                <span>Infraestrutura</span>
                <h2>Status dos workers</h2>
              </div>
              {(role === "admin" || isSuperUser) && (
                <small>
                  Detalhes de host visíveis apenas para superusuário
                </small>
              )}
            </div>
            <div className={styles.workerGrid}>
              {workers.map((worker) => (
                <article key={worker.workerKind}>
                  <span
                    className={`${styles.workerLight} ${styles[worker.status] ?? ""}`}
                  />
                  <div>
                    <strong>
                      {workerLabels[worker.workerKind] ?? worker.workerKind}
                    </strong>
                    <small>
                      {worker.status === "active"
                        ? `Ativo · ${relativeTime(worker.lastSeenAt)}`
                        : worker.status === "offline"
                          ? "Sem heartbeat"
                          : `Atrasado · ${relativeTime(worker.lastSeenAt)}`}
                    </small>
                    {isSuperUser && worker.hostname && (
                      <code>
                        {worker.hostname}
                        {worker.processId ? ` · PID ${worker.processId}` : ""}
                        {worker.version ? ` · ${worker.version}` : ""}
                      </code>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
        <footer className={styles.footerNote}>
          <span>
            Eventos brutos são removidos após 14 dias. Incidentes ativos
            preservam somente o resumo necessário.
          </span>
          {isSuperUser && (
            <Link href="/administracao/zernio">
              Administração Zernio protegida →
            </Link>
          )}
        </footer>
      </section>
      {selectedIncident && (
        <div className={styles.drawerBackdrop} role="presentation" onMouseDown={() => setSelectedIncident(null)}>
          <aside className={styles.incidentDrawer} role="dialog" aria-modal="true" aria-labelledby="incident-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span>Incidente</span><h2 id="incident-title">{selectedIncident.title}</h2></div>
              <button aria-label="Fechar detalhes" onClick={() => setSelectedIncident(null)}>×</button>
            </header>
            {detailsLoading ? <div className={styles.drawerLoading}>Carregando investigação…</div> : incidentDetails && (
              <div className={styles.drawerContent}>
                <section className={styles.drawerSummary}>
                  <code>{incidentDetails.incident.stable_code}</code>
                  <dl>
                    <div><dt>Primeiro registro</dt><dd>{exactTime(incidentDetails.incident.first_seen_at)}</dd></div>
                    <div><dt>Último registro</dt><dd>{exactTime(incidentDetails.incident.last_seen_at)}</dd></div>
                    <div><dt>Ocorrências</dt><dd>{incidentDetails.incident.occurrence_count}</dd></div>
                    <div><dt>Perfis</dt><dd>{incidentDetails.incident.affected_profile_count}</dd></div>
                  </dl>
                </section>
                {Object.keys(incidentDetails.incident.latest_countermeasure ?? {}).length > 0 && (
                  <section><h3>Contramedida aplicada</h3><pre>{JSON.stringify(incidentDetails.incident.latest_countermeasure, null, 2)}</pre></section>
                )}
                <section><h3>Perfis afetados</h3><div className={styles.chips}>{incidentDetails.profiles.length ? incidentDetails.profiles.map((entry) => <span key={entry.profile_id}>@{entry.profile?.username ?? entry.profile_id} · {entry.occurrence_count}</span>) : <small>Nenhum perfil específico associado.</small>}</div></section>
                <section><h3>Entidades vinculadas</h3><div className={styles.chips}>{incidentDetails.entities.length ? incidentDetails.entities.map((entry) => <span key={`${entry.entity_type}-${entry.entity_id}`}>{entry.entity_type} · {entry.state} · {entry.occurrence_count}</span>) : <small>Nenhuma entidade adicional.</small>}</div></section>
                <section><h3>Ocorrências recentes</h3><div className={styles.occurrences}>{incidentDetails.occurrences.map((entry) => <article key={entry.id}><time>{exactTime(entry.occurred_at)}</time><strong>{entry.message}</strong><small>{entry.source_status ?? entry.treatment_state}{entry.http_status ? ` · HTTP ${entry.http_status}` : ""}</small></article>)}</div></section>
                <section><h3>Histórico de tratamento</h3><div className={styles.occurrences}>{incidentDetails.actions.length ? incidentDetails.actions.map((action) => <article key={action.id}><time>{exactTime(action.created_at)}</time><strong>{treatmentLabels[action.previous_treatment]} → {treatmentLabels[action.treatment_state]}</strong><small>{action.justification}{action.actor_email ? ` · ${action.actor_email}` : ""}</small></article>) : <small>Nenhuma ação manual registrada.</small>}</div></section>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
