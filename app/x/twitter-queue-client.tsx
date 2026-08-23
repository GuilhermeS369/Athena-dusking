"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Program = {
  id: string;
  name: string | null;
  status: string;
  funded_count: number;
  unfunded_count: number;
  reserved_micros: number;
  starts_at: string;
  ends_at: string;
  created_at: string;
};
type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  status: string;
};
type Group = { id: string; name: string };
type Membership = { group_id: string; profile_id: string };
type Shortfall = {
  program_id: string;
  profile_id: string;
  requested_count: number;
  funded_count: number;
  unfunded_count: number;
};
type QueueItem = {
  id: string;
  program_id: string;
  profile_id: string;
  execute_at: string;
  content: string;
  category: string;
  amount_micros: number;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
};
type CancelTarget = {
  label: string;
  body: {
    itemId?: string;
    programId?: string;
    profileId?: string;
    groupProfileIds?: string[];
  };
};

const activeStatuses = new Set([
  "ready",
  "retry",
  "claimed",
  "processing",
  "outcome_unknown",
]);
const statusLabels: Record<string, string> = {
  confirmed: "Confirmado",
  completed: "Concluído",
  cancelled: "Cancelado",
  attention: "Requer atenção",
  ready: "Agendado",
  retry: "Aguardando nova tentativa",
  claimed: "Em processamento",
  processing: "Enviado à Zernio",
  outcome_unknown: "Resultado incerto",
  published: "Publicado",
  failed: "Falhou",
};
const usd = (micros: number) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
  }).format(micros / 1_000_000);
const date = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(value));

export default function TwitterQueueClient({
  programs,
  profiles,
  groups,
  memberships,
  shortfalls,
  items,
  canEdit,
}: {
  programs: Program[];
  profiles: Profile[];
  groups: Group[];
  memberships: Membership[];
  shortfalls: Shortfall[];
  items: QueueItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [selectedProgramId, setSelectedProgramId] = useState(
    programs[0]?.id ?? "",
  );
  const [target, setTarget] = useState<CancelTarget | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [itemsByProgram, setItemsByProgram] = useState<
    Record<string, QueueItem[]>
  >(() => (programs[0] ? { [programs[0].id]: items.slice(0, 200) } : {}));
  const [loadingItems, setLoadingItems] = useState(false);
  const initialLast = items.slice(0, 200).at(-1);
  const [cursorByProgram, setCursorByProgram] = useState<
    Record<string, string | null>
  >(() =>
    programs[0] && items.length > 200 && initialLast
      ? {
          [programs[0].id]: btoa(
            JSON.stringify({
              executeAt: initialLast.execute_at,
              id: initialLast.id,
            }),
          )
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", ""),
        }
      : {},
  );
  const [hasMoreByProgram, setHasMoreByProgram] = useState<
    Record<string, boolean>
  >(() => (programs[0] ? { [programs[0].id]: items.length > 200 } : {}));
  const selectedProgram =
    programs.find((program) => program.id === selectedProgramId) ??
    programs[0] ??
    null;
  const profilesById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles],
  );
  const selectedShortfalls = shortfalls.filter(
    (row) => row.program_id === selectedProgram?.id,
  );
  const selectedProfileIds = new Set(
    selectedShortfalls.map((row) => row.profile_id),
  );
  const selectedItems = selectedProgram
    ? (itemsByProgram[selectedProgram.id] ?? [])
    : [];
  const programGroups = groups
    .map((group) => ({
      ...group,
      profileIds: memberships
        .filter(
          (member) =>
            member.group_id === group.id &&
            selectedProfileIds.has(member.profile_id),
        )
        .map((member) => member.profile_id),
    }))
    .filter((group) => group.profileIds.length);

  useEffect(() => {
    if (
      !selectedProgramId ||
      Object.prototype.hasOwnProperty.call(itemsByProgram, selectedProgramId)
    )
      return;
    let cancelled = false;
    setLoadingItems(true);
    void fetch(
      `/api/x/queue?programId=${encodeURIComponent(selectedProgramId)}`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          items?: QueueItem[];
          nextCursor?: string | null;
          hasMore?: boolean;
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            body.error ?? "Não foi possível carregar os itens deste programa.",
          );
        if (!cancelled) {
          setItemsByProgram((current) => ({
            ...current,
            [selectedProgramId]: body.items ?? [],
          }));
          setCursorByProgram((current) => ({
            ...current,
            [selectedProgramId]: body.nextCursor ?? null,
          }));
          setHasMoreByProgram((current) => ({
            ...current,
            [selectedProgramId]: Boolean(body.hasMore),
          }));
        }
      })
      .catch((error) => {
        if (!cancelled)
          setMessage(
            error instanceof Error ? error.message : "Falha ao carregar itens.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProgramId, itemsByProgram]);

  function requestCancel(next: CancelTarget) {
    setTarget(next);
    setReason("");
    setMessage(null);
  }
  async function loadMore() {
    if (
      !selectedProgram ||
      !hasMoreByProgram[selectedProgram.id] ||
      loadingItems
    )
      return;
    setLoadingItems(true);
    try {
      const cursor = cursorByProgram[selectedProgram.id];
      const response = await fetch(
        `/api/x/queue?programId=${encodeURIComponent(selectedProgram.id)}&cursor=${encodeURIComponent(cursor ?? "")}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as {
        items?: QueueItem[];
        nextCursor?: string | null;
        hasMore?: boolean;
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error ?? "Não foi possível carregar mais itens.");
      setItemsByProgram((current) => ({
        ...current,
        [selectedProgram.id]: [
          ...(current[selectedProgram.id] ?? []),
          ...(body.items ?? []),
        ],
      }));
      setCursorByProgram((current) => ({
        ...current,
        [selectedProgram.id]: body.nextCursor ?? null,
      }));
      setHasMoreByProgram((current) => ({
        ...current,
        [selectedProgram.id]: Boolean(body.hasMore),
      }));
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Falha ao carregar mais itens.",
      );
    } finally {
      setLoadingItems(false);
    }
  }
  async function confirmCancel() {
    if (!target || reason.trim().length < 4) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/x/queue/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...target.body,
          reason: reason.trim(),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        affectedItems?: number;
        releasedMicros?: number;
        pendingReconciliation?: number;
      };
      if (!response.ok)
        throw new Error(body.error ?? "Não foi possível cancelar a fila X.");
      const pending = Number(body.pendingReconciliation ?? 0);
      setMessage(
        `${Number(body.affectedItems ?? 0)} item(ns) cancelado(s); ${usd(Number(body.releasedMicros ?? 0))} voltou ao saldo disponível.${pending ? ` ${pending} item(ns) já iniciado(s) continuam bloqueados até reconciliação.` : ""}`,
      );
      setTarget(null);
      setReason("");
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Falha no cancelamento.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!programs.length)
    return (
      <div className="empty-state">
        <h2>Fila X vazia</h2>
        <p>Nenhum programa foi confirmado.</p>
      </div>
    );
  if (!selectedProgram) return null;
  return (
    <section className="content-stack">
      {message ? (
        <div className="notice-banner" role="status">
          {message}
        </div>
      ) : null}
      <div className="panel queue-classic-controls">
        <label>
          Programa
          <select
            value={selectedProgram.id}
            onChange={(event) => setSelectedProgramId(event.target.value)}
          >
            {programs.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name ?? `Programa ${program.id.slice(0, 8)}`} ·{" "}
                {statusLabels[program.status] ?? program.status} ·{" "}
                {date(program.starts_at)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <article className="panel">
        <div className="standalone-header">
          <div>
            <span className="section-kicker">
              Programa {selectedProgram.id.slice(0, 8)}
            </span>
            <h2>
              {selectedProgram.name ??
                statusLabels[selectedProgram.status] ??
                selectedProgram.status}
            </h2>
            <p className="muted">
              {statusLabels[selectedProgram.status] ?? selectedProgram.status} ·{" "}
              {date(selectedProgram.starts_at)} até{" "}
              {date(selectedProgram.ends_at)}
            </p>
          </div>
          {canEdit && selectedProgram.status === "confirmed" ? (
            <button
              className="button button-danger"
              type="button"
              onClick={() =>
                requestCancel({
                  label: "todo o programa",
                  body: { programId: selectedProgram.id },
                })
              }
            >
              Cancelar programa
            </button>
          ) : null}
        </div>
        <div className="summary-grid">
          <div>
            <span>Financiados</span>
            <strong>{selectedProgram.funded_count}</strong>
          </div>
          <div>
            <span>Sem saldo</span>
            <strong>{selectedProgram.unfunded_count}</strong>
          </div>
          <div>
            <span>Reserva inicial</span>
            <strong>{usd(selectedProgram.reserved_micros)}</strong>
          </div>
          <div>
            <span>Itens exibidos</span>
            <strong>{selectedItems.length}</strong>
          </div>
        </div>
      </article>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">Escopo por perfil</span>
            <h2>Perfis deste programa</h2>
            <p>
              O cancelamento combina programa + perfil; outras programações do
              perfil não são afetadas.
            </p>
          </div>
        </div>
        <div className="content-stack">
          {selectedShortfalls.map((row) => {
            const profile = profilesById.get(row.profile_id);
            return (
              <div className="standalone-header" key={row.profile_id}>
                <div>
                  <strong>
                    @{profile?.username ?? row.profile_id.slice(0, 8)}
                  </strong>
                  <p className="muted">
                    {row.funded_count} financiado(s) · {row.unfunded_count} sem
                    saldo
                  </p>
                </div>
                {canEdit && selectedProgram.status === "confirmed" ? (
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() =>
                      requestCancel({
                        label: `a fila de @${profile?.username ?? row.profile_id.slice(0, 8)} neste programa`,
                        body: {
                          programId: selectedProgram.id,
                          profileId: row.profile_id,
                        },
                      })
                    }
                  >
                    Cancelar neste programa
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">Escopo por grupo</span>
            <h2>Grupos com perfis neste programa</h2>
            <p>
              A associação atual do grupo é congelada no pedido; somente esses
              perfis e este programa serão alcançados.
            </p>
          </div>
        </div>
        {programGroups.length ? (
          <div className="content-stack">
            {programGroups.map((group) => (
              <div className="standalone-header" key={group.id}>
                <div>
                  <strong>{group.name}</strong>
                  <p className="muted">
                    {group.profileIds.length} perfil(is) participante(s)
                  </p>
                </div>
                {canEdit && selectedProgram.status === "confirmed" ? (
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() =>
                      requestCancel({
                        label: `o grupo ${group.name} neste programa`,
                        body: {
                          programId: selectedProgram.id,
                          groupProfileIds: group.profileIds,
                        },
                      })
                    }
                  >
                    Cancelar grupo neste programa
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            Nenhum grupo atual contém perfis deste programa.
          </p>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">Itens financiados</span>
            <h2>Próximas publicações</h2>
            <p>
              Carregadas em páginas de 200; ações de programa, perfil e grupo
              atuam no escopo completo.
            </p>
          </div>
        </div>
        <div className="content-stack">
          {selectedItems.length ? (
            selectedItems.map((item) => {
              const profile = profilesById.get(item.profile_id);
              return (
                <article className="standalone-header" key={item.id}>
                  <div>
                    <strong>
                      @{profile?.username ?? item.profile_id.slice(0, 8)} ·{" "}
                      {date(item.execute_at)}
                    </strong>
                    <p className="muted">
                      {statusLabels[item.status] ?? item.status} ·{" "}
                      {usd(item.amount_micros)} · tentativa {item.attempt_count}
                    </p>
                    <p>
                      {item.content.length > 180
                        ? `${item.content.slice(0, 180)}…`
                        : item.content}
                    </p>
                    {item.status === "outcome_unknown" ? (
                      <p className="field-error-message">
                        Resultado incerto: cancelar não libera o hold sem
                        reconciliação.
                      </p>
                    ) : null}
                  </div>
                  {canEdit && activeStatuses.has(item.status) ? (
                    <button
                      type="button"
                      className="button button-danger"
                      onClick={() =>
                        requestCancel({
                          label: `o item ${item.id.slice(0, 8)}`,
                          body: { itemId: item.id },
                        })
                      }
                    >
                      Cancelar item
                    </button>
                  ) : null}
                </article>
              );
            })
          ) : (
            <p className="muted">
              {loadingItems
                ? "Carregando itens…"
                : "Nenhum item financiado neste programa."}
            </p>
          )}
          {selectedProgram && hasMoreByProgram[selectedProgram.id] ? (
            <button
              className="button button-ghost"
              type="button"
              disabled={loadingItems}
              onClick={() => void loadMore()}
            >
              {loadingItems ? "Carregando…" : "Ver mais publicações"}
            </button>
          ) : null}
        </div>
      </section>
      {target ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="panel bulk-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="twitter-cancel-title"
          >
            <div className="panel-heading">
              <div>
                <span className="section-kicker">
                  Cancelamento financeiro seguro
                </span>
                <h2 id="twitter-cancel-title">Cancelar {target.label}</h2>
              </div>
            </div>
            <p>
              Itens ainda não iniciados liberam a reserva. Itens já enviados à
              Zernio permanecem em hold e aparecem nos Logs até reconciliação;
              nenhuma chamada será repetida.
            </p>
            <label>
              Motivo obrigatório
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={4}
                maxLength={1000}
                rows={4}
                autoFocus
              />
            </label>
            <div className="detail-actions">
              <button
                className="button button-ghost"
                type="button"
                disabled={busy}
                onClick={() => setTarget(null)}
              >
                Voltar
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={busy || reason.trim().length < 4}
                onClick={() => void confirmCancel()}
              >
                {busy ? "Cancelando…" : "Confirmar cancelamento"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
