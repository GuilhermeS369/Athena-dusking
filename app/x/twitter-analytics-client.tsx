'use client';

import { useMemo, useState } from 'react';

import {
  filterTwitterAnalyticsResources,
  type TwitterAnalyticsFilter,
} from '@/lib/twitter/analytics-filters';

type Resource = {
  id: string;
  profileId: string;
  label: string;
  detail: string;
  occurredAt?: string;
};

type Group = {
  id: string;
  label: string;
  profileIds: string[];
};

type Quote = {
  reviewToken: string;
  resourceCount: number;
  postCount: number;
  profileCount: number;
  totalMicros: number;
  postReadUnitMicros: number;
  postReadReserveUnits: number;
  postReadMaximumMicros: number;
  profileReadUnitMicros: number;
  profileReadReserveUnits: number;
  canConfirm: boolean;
  walletSnapshots: Array<{
    identityId: string;
    availableMicros: number;
    reservedMicros: number;
    analyticsCostMicros: number;
    projectedAvailableMicros: number;
    protectedFloorMicros: number;
    canFund: boolean;
  }>;
};

const EMPTY_FILTER: TwitterAnalyticsFilter = {
  profileId: '',
  groupId: '',
  fromDate: '',
  toDate: '',
  metricType: 'all',
};

const usd = (micros: number) => `US$ ${(micros / 1e6).toFixed(3)}`;

export function TwitterAnalyticsClient({
  posts,
  profiles,
  groups,
  enabled,
}: {
  posts: Resource[];
  profiles: Resource[];
  groups: Group[];
  enabled: boolean;
}) {
  const [postIds, setPostIds] = useState<string[]>([]);
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<TwitterAnalyticsFilter>(EMPTY_FILTER);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const request = useMemo(() => ({ postIds, profileIds }), [postIds, profileIds]);

  const visibleResources = useMemo(
    () =>
      filterTwitterAnalyticsResources(
        [
          ...posts.map((post) => ({
            ...post,
            resourceType: 'post' as const,
          })),
          ...profiles.map((profile) => ({
            ...profile,
            resourceType: 'profile' as const,
          })),
        ],
        groups,
        filter,
      ),
    [filter, groups, posts, profiles],
  );
  const visiblePostIds = new Set(
    visibleResources
      .filter((resource) => resource.resourceType === 'post')
      .map((resource) => resource.id),
  );
  const visibleProfileIds = new Set(
    visibleResources
      .filter((resource) => resource.resourceType === 'profile')
      .map((resource) => resource.id),
  );
  const visiblePosts = posts.filter((post) => visiblePostIds.has(post.id));
  const visibleProfiles = profiles.filter((profile) =>
    visibleProfileIds.has(profile.id),
  );

  function toggle(
    id: string,
    values: string[],
    setValues: (value: string[]) => void,
  ) {
    setValues(
      values.includes(id)
        ? values.filter((value) => value !== id)
        : [...values, id],
    );
    setQuote(null);
  }

  function updateFilter(values: Partial<TwitterAnalyticsFilter>) {
    setFilter((current) => ({ ...current, ...values }));
  }

  function selectVisible() {
    setPostIds((current) => [...new Set([...current, ...visiblePostIds])]);
    setProfileIds((current) => [...new Set([...current, ...visibleProfileIds])]);
    setQuote(null);
  }

  function clearSelection() {
    setPostIds([]);
    setProfileIds([]);
    setQuote(null);
  }

  async function review() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/x/analytics/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) setQuote(payload);
      else setMessage(payload.error ?? 'Falha na revisão.');
    } catch {
      setMessage('Não foi possível revisar o custo.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true);
    try {
      const response = await fetch('/api/x/analytics/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request,
          reviewToken: quote.reviewToken,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      setMessage(
        response.ok
          ? `Job criado para ${payload.resourceCount} recurso(s).`
          : (payload.error ?? 'Falha na confirmação.'),
      );
      if (response.ok) clearSelection();
    } catch {
      setMessage('Não foi possível confirmar a análise.');
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) {
    return (
      <div className="empty-state">
        <h2>Análises X desabilitadas</h2>
        <p>
          A ativação ocorre somente após o canário financeiro. Nenhuma leitura em
          background será feita.
        </p>
      </div>
    );
  }

  return (
    <div className="content-stack">
      <section className="panel content-stack">
        <h2>Filtros locais</h2>
        <p>
          Filtrar não consulta a Zernio nem reserva saldo. Somente os recursos
          marcados entram na revisão.
        </p>
        <div className="summary-grid">
          <label>
            Perfil
            <select
              value={filter.profileId}
              onChange={(event) => updateFilter({ profileId: event.target.value })}
            >
              <option value="">Todos os perfis</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Grupo
            <select
              value={filter.groupId}
              onChange={(event) => updateFilter({ groupId: event.target.value })}
            >
              <option value="">Todos os grupos</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tipo de métrica
            <select
              value={filter.metricType}
              onChange={(event) =>
                updateFilter({
                  metricType: event.target
                    .value as TwitterAnalyticsFilter['metricType'],
                })
              }
            >
              <option value="all">Posts e perfis</option>
              <option value="post">Métricas de posts</option>
              <option value="profile">Perfil e followers</option>
            </select>
          </label>
          <label>
            Publicado de
            <input
              type="date"
              value={filter.fromDate}
              onChange={(event) => updateFilter({ fromDate: event.target.value })}
            />
          </label>
          <label>
            Publicado até
            <input
              type="date"
              value={filter.toDate}
              min={filter.fromDate || undefined}
              onChange={(event) => updateFilter({ toDate: event.target.value })}
            />
          </label>
        </div>
        <div className="action-row">
          <button type="button" onClick={selectVisible}>
            Selecionar recursos visíveis
          </button>
          <button type="button" onClick={clearSelection}>
            Limpar seleção
          </button>
          <button type="button" onClick={() => setFilter(EMPTY_FILTER)}>
            Limpar filtros
          </button>
        </div>
        <p>
          {visiblePosts.length + visibleProfiles.length} recurso(s) visível(is) ·{' '}
          {postIds.length + profileIds.length} selecionado(s).
        </p>
      </section>

      {filter.metricType !== 'profile' ? (
        <section className="panel content-stack">
          <h2>Posts publicados · US$ 0,005 por leitura</h2>
          <p>
            Reserva máxima de 9 leituras (US$ 0,045) por post. Somente o uso
            comprovado será debitado; o restante será liberado.
          </p>
          {visiblePosts.length ? (
            visiblePosts.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={postIds.includes(item.id)}
                  onChange={() => toggle(item.id, postIds, setPostIds)}
                />{' '}
                {item.label} <small>{item.detail}</small>
              </label>
            ))
          ) : (
            <p>Nenhum post publicado corresponde aos filtros.</p>
          )}
        </section>
      ) : null}

      {filter.metricType !== 'post' ? (
        <section className="panel content-stack">
          <h2>Perfis e followers · US$ 0,010 cada</h2>
          {visibleProfiles.length ? (
            visibleProfiles.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={profileIds.includes(item.id)}
                  onChange={() => toggle(item.id, profileIds, setProfileIds)}
                />{' '}
                {item.label} <small>{item.detail}</small>
              </label>
            ))
          ) : (
            <p>Nenhum perfil corresponde aos filtros.</p>
          )}
        </section>
      ) : null}

      <button
        disabled={busy || postIds.length + profileIds.length === 0}
        onClick={review}
      >
        Revisar custo
      </button>

      {quote ? (
        <section className="panel content-stack">
          <h2>Revisão somente leitura</h2>
          <p>
            {quote.postCount} post(s), {quote.profileCount} perfil(is). Reserva
            máxima:{' '}
            <strong>{usd(quote.totalMicros)}</strong>.
          </p>
          <p>
            Posts: {usd(quote.postReadUnitMicros)} por leitura, até{' '}
            {quote.postReadReserveUnits} leituras por post. Perfis:{' '}
            {usd(quote.profileReadUnitMicros)} por leitura. A liquidação será
            feita apenas após comprovação; resultados incertos ficam retidos
            para reconciliação, sem retry automático.
          </p>
          {quote.walletSnapshots.map((wallet) => (
            <div className="summary-grid" key={wallet.identityId}>
              <div>
                <span>Disponível</span>
                <strong>{usd(wallet.availableMicros)}</strong>
              </div>
              <div>
                <span>Já reservado</span>
                <strong>{usd(wallet.reservedMicros)}</strong>
              </div>
              <div>
                <span>Reserva máxima</span>
                <strong>{usd(wallet.analyticsCostMicros)}</strong>
              </div>
              <div>
                <span>Após reserva máxima</span>
                <strong>{usd(wallet.projectedAvailableMicros)}</strong>
              </div>
              <div>
                <span>Piso protegido</span>
                <strong>{usd(wallet.protectedFloorMicros)}</strong>
              </div>
            </div>
          ))}
          <button disabled={busy || !quote.canConfirm} onClick={confirm}>
            Confirmar e reservar
          </button>
          {!quote.canConfirm ? (
            <p>Saldo insuficiente após preservar US$ 5,00 para publicações.</p>
          ) : null}
        </section>
      ) : null}

      {message ? <p>{message}</p> : null}
    </div>
  );
}
