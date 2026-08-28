"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import base from "@/app/postagem/bulk-publishing.module.css";
import {
  BULK_PROFILE_RENDER_BATCH,
  bulkProfileRenderLimit,
  selectAllBulkProfileIds,
  toggleBulkProfileSelection,
} from "@/lib/publications/bulk-ui";
import {
  containsHttpUrl,
  countTwitterWeightedCharacters,
  getTwitterCharacterLimit,
  getTwitterCreatePrice,
} from "@/lib/twitter/pricing";
import {
  fillTwitterTextFieldsFromClipboard,
  resolveTwitterImageRotationSets,
  twitterFormatProgress,
} from "@/lib/twitter/bulk-ui";
import type { BulkRotationOrderMode } from "@/lib/publications/bulk-rotation";
import styles from "./twitter-bulk.module.css";

type PostFormat = "text" | "images" | "gif" | "video";
type QueueSummary = {
  text_count: number;
  image_count: number;
  gif_count: number;
  video_count: number;
  published_text_count: number;
  published_image_count: number;
  published_gif_count: number;
  published_video_count: number;
  pending_count: number;
  blocking_count: number;
  last_execute_at: string | null;
};
type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  account_tier: "free" | "premium" | "unknown";
  identity_id: string;
  posted_micros: number;
  reserved_micros: number;
  available_micros: number;
  group_ids: string[];
  queue: QueueSummary;
};
type ProfileGroup = { id: string; name: string };
type MediaGroup = { id: string; name: string };
type Asset = {
  id: string;
  original_name: string;
  media_kind: "image" | "gif" | "video";
  byte_size: number;
  signed_url: string | null;
  group_ids: string[];
};
type MediaSet = {
  clientKey: string;
  mediaKind: "images" | "gif" | "video";
  assetIds: string[];
};
type Review = {
  reviewToken: string;
  name: string;
  totalRequested: number;
  fundedCount: number;
  unfundedCount: number;
  reservedMicros: number;
  costBreakdown: Array<{
    category: "post_dm_create" | "post_create_url";
    count: number;
    totalMicros: number;
  }>;
  typeBreakdown: Array<{
    type: "text" | "images" | "gif" | "video";
    count: number;
  }>;
  shortfalls: Array<{
    profile_id: string;
    requested_count: number;
    funded_count: number;
    unfunded_count: number;
  }>;
  walletSnapshots: Array<{
    identityId: string;
    postedMicros: number;
    reservedMicros: number;
    availableMicros: number;
    programReservationMicros: number;
    projectedAvailableMicros: number;
  }>;
  warnings: Array<{ profileId: string; message: string }>;
  schedule: { count: number; first: string; last: string };
};

const formatLabels: Record<PostFormat, string> = {
  text: "Somente texto",
  images: "Imagens (1–4 por post)",
  gif: "GIF",
  video: "Vídeo",
};
const typeLabels = {
  text: "Texto",
  images: "Imagens",
  gif: "GIF",
  video: "Vídeo",
};
const usd = (value: number) =>
  `US$ ${(value / 1e6).toFixed(3).replace(".", ",")}`;
const date = (value: string) =>
  new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
const rotationSeed = () => `twitter-rotation-${crypto.randomUUID()}`;
const queueForFormat = (profile: Profile, format: PostFormat) =>
  format === "text"
    ? profile.queue.text_count
    : format === "images"
      ? profile.queue.image_count
      : format === "gif"
        ? profile.queue.gif_count
        : profile.queue.video_count;
const publishedForFormat = (profile: Profile, format: PostFormat) =>
  format === "text"
    ? profile.queue.published_text_count
    : format === "images"
      ? profile.queue.published_image_count
      : format === "gif"
        ? profile.queue.published_gif_count
        : profile.queue.published_video_count;

export default function TwitterBulkClient({
  profiles,
  assets,
  profileGroups,
  mediaGroups,
  initialMediaHasMore,
  initialMediaCursor,
}: {
  profiles: Profile[];
  assets: Asset[];
  profileGroups: ProfileGroup[];
  mediaGroups: MediaGroup[];
  initialMediaHasMore:boolean;
  initialMediaCursor:string|null;
}) {
  const router = useRouter();
  const [availableAssets,setAvailableAssets]=useState(assets);
  const [mediaHasMore,setMediaHasMore]=useState(initialMediaHasMore);
  const [mediaCursor,setMediaCursor]=useState(initialMediaCursor);
  const [loadingMedia,setLoadingMedia]=useState(false);
  const [profileSelection, setProfileSelection] = useState({
    ids: [] as string[],
    anchorId: null as string | null,
  });
  const [profileSearch, setProfileSearch] = useState("");
  const [profileGroupId, setProfileGroupId] = useState("");
  const [balanceFilter, setBalanceFilter] = useState<
    "all" | "eligible" | "blocked"
  >("all");
  const [renderLimit, setRenderLimit] = useState(BULK_PROFILE_RENDER_BATCH);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<PostFormat>("text");
  const [texts, setTexts] = useState([""]);
  const [originKey, setOriginKey] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [imageSets, setImageSets] = useState<MediaSet[]>([]);
  const [orderMode, setOrderMode] =
    useState<BulkRotationOrderMode>("diversified");
  const [rotationSeedValue, setRotationSeedValue] = useState(rotationSeed);
  const [scheduleKind, setScheduleKind] = useState<"interval" | "daily">(
    "interval",
  );
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [durationDays, setDurationDays] = useState(1);
  const [dailyTime, setDailyTime] = useState("09:00");
  const [days, setDays] = useState(7);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<"review" | "confirm" | null>(null);
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const invalidate = () => {
    setReview(null);
    setConfirmed(false);
  };
  const usableTexts = texts.map((text) => text.trim()).filter(Boolean);
  const textDetails = usableTexts.map((text) => ({
    text,
    weighted: countTwitterWeightedCharacters(text),
    url: containsHttpUrl(text),
    price: getTwitterCreatePrice(text).amountMicros,
  }));
  const minimumCost = textDetails.length
    ? Math.min(...textDetails.map((text) => text.price))
    : 15_000;
  const selectable = (profile: Profile) =>
    profile.queue.blocking_count === 0 &&
    profile.available_micros >= minimumCost;
  const orderedProfiles = useMemo(() => {
    const query = profileSearch.trim().toLocaleLowerCase("pt-BR");
    return profiles
      .filter(
        (profile) =>
          (!profileGroupId || profile.group_ids.includes(profileGroupId)) &&
          (balanceFilter === "all" ||
            (balanceFilter === "eligible"
              ? selectable(profile)
              : !selectable(profile))) &&
          (!query ||
            `${profile.username} ${profile.display_name ?? ""}`
              .toLocaleLowerCase("pt-BR")
              .includes(query)),
      )
      .sort((left, right) => {
        const leftScheduled = queueForFormat(left, format),
          rightScheduled = queueForFormat(right, format),
          leftTotal = leftScheduled + publishedForFormat(left, format),
          rightTotal = rightScheduled + publishedForFormat(right, format);
        if ((leftTotal === 0) !== (rightTotal === 0))
          return leftTotal === 0 ? -1 : 1;
        return (
          leftScheduled - rightScheduled ||
          leftTotal - rightTotal ||
          left.username.localeCompare(right.username, "pt-BR", {
            sensitivity: "base",
          }) ||
          left.id.localeCompare(right.id)
        );
      });
  }, [
    profiles,
    profileGroupId,
    profileSearch,
    balanceFilter,
    format,
    minimumCost,
  ]);
  const renderedProfiles = orderedProfiles.slice(0, renderLimit);
  const eligibleOrderedIds = orderedProfiles
    .filter(selectable)
    .map((profile) => profile.id);
  const selectedProfiles = profiles.filter((profile) =>
    profileSelection.ids.includes(profile.id),
  );
  const originAssets = useMemo(() => {
    if (!originKey || format === "text") return [];
    const groupId = originKey.startsWith("group:") ? originKey.slice(6) : null;
    return availableAssets.filter((asset) => {
      const inOrigin = groupId
        ? asset.group_ids.includes(groupId)
        : asset.group_ids.length === 0;
      const compatible =
        format === "images"
          ? asset.media_kind === "image"
          : asset.media_kind === format;
      return inOrigin && compatible;
    });
  }, [availableAssets, originKey, format]);
  async function loadMoreMedia(){if(!mediaCursor||loadingMedia||format==='text'||!originKey)return;setLoadingMedia(true);try{const group=originKey.startsWith('group:')?originKey.slice(6):'none';const type=format==='images'?'image':format;const response=await fetch(`/api/x/media?cursor=${encodeURIComponent(mediaCursor)}&limit=100&type=${type}&group=${encodeURIComponent(group)}&status=schedulable`,{cache:'no-store'});const body=await response.json()as{assets?:Array<{id:string;original_name:string;kind:Asset['media_kind'];size_bytes:number;signed_url:string|null;group_ids:string[]}>;hasMore?:boolean;nextCursor?:string|null;error?:string};if(!response.ok)throw new Error(body.error??'Falha ao carregar mídias X.');const mapped=(body.assets??[]).map(asset=>({id:asset.id,original_name:asset.original_name,media_kind:asset.kind,byte_size:asset.size_bytes,signed_url:asset.signed_url,group_ids:asset.group_ids}));setAvailableAssets(current=>{const byId=new Map(current.map(asset=>[asset.id,asset]));for(const asset of mapped)byId.set(asset.id,asset);return[...byId.values()];});setMediaHasMore(body.hasMore===true);setMediaCursor(body.nextCursor??null);}catch(error){setMessage(error instanceof Error?error.message:'Falha ao carregar mídias X.');}finally{setLoadingMedia(false);}}
  const effectiveMediaSets = useMemo<MediaSet[]>(() => {
    if (format === "text") return [];
    if (format === "images")
      return resolveTwitterImageRotationSets(originAssets, imageSets);
    return originAssets.map((asset) => ({
      clientKey: `origin:${format}:${asset.id}`,
      mediaKind: format,
      assetIds: [asset.id],
    }));
  }, [format, imageSets, originAssets]);
  const slots =
    scheduleKind === "interval"
      ? Math.floor((durationDays * 1440) / Math.max(1, intervalMinutes))
      : days;
  const projected = slots * profileSelection.ids.length;
  const sharedWallets = new Map<string, number>();
  const walletProfileCounts = new Map<string, number>();
  for (const profile of profiles)
    walletProfileCounts.set(
      profile.identity_id,
      (walletProfileCounts.get(profile.identity_id) ?? 0) + 1,
    );
  for (const profile of selectedProfiles)
    sharedWallets.set(profile.identity_id, profile.available_micros);
  const selectedBalance = [...sharedWallets.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const validTextCount = textDetails.filter((text) =>
    selectedProfiles.every(
      (profile) =>
        text.weighted <= getTwitterCharacterLimit(profile.account_tier),
    ),
  ).length;
  const blockedVisible = orderedProfiles.filter(
    (profile) => !selectable(profile),
  ).length;
  const reviewProfileRows = useMemo(() => {
    if (!review) return [];
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const walletByIdentity = new Map(
      review.walletSnapshots.map((wallet, index) => [
        wallet.identityId,
        { ...wallet, number: index + 1 },
      ]),
    );
    const reviewedProfilesByIdentity = new Map<string, number>();
    for (const row of review.shortfalls) {
      const identityId = profileById.get(row.profile_id)?.identity_id;
      if (identityId)
        reviewedProfilesByIdentity.set(
          identityId,
          (reviewedProfilesByIdentity.get(identityId) ?? 0) + 1,
        );
    }
    return review.shortfalls
      .map((shortfall) => {
        const profile = profileById.get(shortfall.profile_id);
        const wallet = profile
          ? walletByIdentity.get(profile.identity_id)
          : undefined;
        return {
          shortfall,
          profile,
          wallet,
          walletProfileCount: profile
            ? (reviewedProfilesByIdentity.get(profile.identity_id) ?? 1)
            : 1,
        };
      })
      .sort((left, right) => {
        const leftUsername = left.profile?.username ?? left.shortfall.profile_id;
        const rightUsername =
          right.profile?.username ?? right.shortfall.profile_id;
        return (
          leftUsername.localeCompare(rightUsername, "pt-BR", {
            sensitivity: "base",
          }) || left.shortfall.profile_id.localeCompare(right.shortfall.profile_id)
        );
      });
  }, [profiles, review]);
  const request = {
    scheduleVersion: 2 as const,
    name: name.trim(),
    profileIds: profileSelection.ids,
    texts: usableTexts,
    mediaSets: effectiveMediaSets,
    orderMode,
    rotationSeed: rotationSeedValue,
    schedule:
      scheduleKind === "interval"
        ? { kind: scheduleKind, intervalMinutes, durationDays }
        : { kind: scheduleKind, dailyTime, days },
  };
  function toggleProfile(profile: Profile, shiftKey: boolean) {
    if (!selectable(profile)) return;
    invalidate();
    setProfileSelection((current) =>
      toggleBulkProfileSelection(
        current,
        eligibleOrderedIds,
        profile.id,
        shiftKey,
      ),
    );
  }
  function selectAllFiltered() {
    invalidate();
    setProfileSelection((current) => ({
      ids: selectAllBulkProfileIds(current.ids, eligibleOrderedIds),
      anchorId: eligibleOrderedIds.at(-1) ?? current.anchorId,
    }));
  }
  function clearProfiles() {
    invalidate();
    setProfileSelection({ ids: [], anchorId: null });
  }
  function changeFormat(next: PostFormat) {
    invalidate();
    setFormat(next);
    setOriginKey("");
    setSelectedAssets([]);
    setImageSets([]);
  }
  function updateText(index: number, value: string) {
    invalidate();
    setTexts((current) =>
      current.map((text, currentIndex) =>
        currentIndex === index ? value : text,
      ),
    );
  }
  function pasteTextList(
    index: number,
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) {
    const filled = fillTwitterTextFieldsFromClipboard(
      texts,
      index,
      event.clipboardData.getData("text"),
    );
    if (!filled) return;
    event.preventDefault();
    invalidate();
    setTexts(filled);
  }
  function addImageSet() {
    const ids = originAssets
      .filter((asset) => selectedAssets.includes(asset.id))
      .map((asset) => asset.id)
      .slice(0, 4);
    if (!ids.length) return;
    const clientKey = `images:${ids.join(":")}`;
    if (imageSets.some((set) => set.clientKey === clientKey)) {
      setMessage("Este conjunto de imagens já foi adicionado.");
      return;
    }
    invalidate();
    setImageSets((current) => [
      ...current,
      { clientKey, mediaKind: "images", assetIds: ids },
    ]);
    setSelectedAssets([]);
    setMessage("");
  }
  async function doReview() {
    setMessage("");
    setReview(null);
    setBusy("review");
    try {
      const response = await fetch("/api/x/bulk/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await response.json()) as Partial<Review> & {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Falha na revisão X.");
      if (
        !body.reviewToken ||
        !Array.isArray(body.costBreakdown) ||
        !Array.isArray(body.walletSnapshots) ||
        !Array.isArray(body.shortfalls) ||
        !Array.isArray(body.typeBreakdown)
      )
        throw new Error(
          "A revisão X retornou um contrato incompleto. Nada foi reservado.",
        );
      setReview(body as Review);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Falha na revisão X.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function confirm() {
    if (!review?.reviewToken) return;
    setBusy("confirm");
    try {
      const response = await fetch("/api/x/bulk/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request,
          reviewToken: review.reviewToken,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        fundedCount?: number;
      };
      if (!response.ok) {
        if (response.status === 409) setReview(null);
        throw new Error(body.error ?? "Falha na confirmação X.");
      }
      setMessage(
        `Programa confirmado com ${body.fundedCount ?? review.fundedCount} itens financiados.`,
      );
      setReview(null);
      setConfirmed(true);
      setRotationSeedValue(rotationSeed());
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Falha na confirmação X.",
      );
    } finally {
      setBusy(null);
    }
  }
  if (!profiles.length)
    return (
      <section className="panel empty-state">
        <h2>Nenhum perfil X conectado</h2>
        <p>Conecte uma identidade antes de criar uma programação.</p>
        <Link className="button button-secondary" href="/x/zernio">
          Abrir Zernio
        </Link>
      </section>
    );
  const mediaReady = format === "text" || effectiveMediaSets.length > 0;
  const contentReady = usableTexts.length > 0 || effectiveMediaSets.length > 0;
  const canReview = Boolean(
    name.trim() &&
    profileSelection.ids.length &&
    contentReady &&
    validTextCount === usableTexts.length &&
    slots > 0 &&
    mediaReady,
  );
  return (
    <section className={base.shell} aria-labelledby="twitter-bulk-title">
      <header className={base.header}>
        <div>
          <span className="section-kicker">Plano compacto X</span>
          <h2 id="twitter-bulk-title">Programar em massa</h2>
          <p>
            Formato, perfis, textos, mídia, horários e custos trabalham como um
            único plano.
          </p>
        </div>
      </header>
      {message ? (
        <p className={base.message} role="status">
          {message}
          {confirmed ? <Link href="/x/fila"> Abrir fila X →</Link> : null}
        </p>
      ) : null}
      <div className={base.workspace}>
        <aside className={`${base.profilesPanel} ${styles.twitterProfilesPanel}`}>
          <div className={base.panelHeader}>
            <div>
              <strong>Perfis X</strong>
              <small>
                {profileSelection.ids.length} selecionados ·{" "}
                {orderedProfiles.length} disponíveis no filtro
              </small>
            </div>
            <div className={base.profileActions}>
              <button
                type="button"
                onClick={selectAllFiltered}
                disabled={!eligibleOrderedIds.length}
              >
                Selecionar todos
              </button>
              <button
                type="button"
                onClick={clearProfiles}
                disabled={!profileSelection.ids.length}
              >
                Limpar
              </button>
            </div>
          </div>
          <label className={base.profileGroupFilter}>
            <span>Filtrar perfis por grupo</span>
            <select
              value={profileGroupId}
              onChange={(event) => {
                setProfileGroupId(event.target.value);
                setRenderLimit(BULK_PROFILE_RENDER_BATCH);
              }}
            >
              <option value="">Sem grupo selecionado</option>
              {profileGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <input
            className={base.search}
            type="search"
            value={profileSearch}
            onChange={(event) => {
              setProfileSearch(event.target.value);
              setRenderLimit(BULK_PROFILE_RENDER_BATCH);
            }}
            placeholder="Buscar perfil"
            aria-label="Buscar perfil X"
          />
          <select
            className={base.search}
            value={balanceFilter}
            onChange={(event) =>
              setBalanceFilter(event.target.value as typeof balanceFilter)
            }
            aria-label="Filtrar por saldo"
          >
            <option value="all">Com e sem saldo</option>
            <option value="eligible">Elegíveis para o conteúdo</option>
            <option value="blocked">Sem saldo ou bloqueados</option>
          </select>
          <div
            className={`${base.profileList} ${styles.twitterProfileList}`}
            onScroll={(event) => {
              if (
                event.currentTarget.scrollTop +
                  event.currentTarget.clientHeight >=
                event.currentTarget.scrollHeight - 100
              )
                setRenderLimit((current) =>
                  bulkProfileRenderLimit(current, orderedProfiles.length),
                );
            }}
            onWheel={(event) => {
              if (!event.shiftKey) return;
              const delta = event.deltaY || event.deltaX;
              if (!delta) return;
              event.preventDefault();
              event.currentTarget.scrollTop += delta;
            }}
            aria-label="Lista de perfis X"
          >
            {!orderedProfiles.length ? (
              <p>Nenhum perfil encontrado.</p>
            ) : (
              renderedProfiles.map((profile) => {
                const selected = profileSelection.ids.includes(profile.id),
                  enabled = selectable(profile),
                  scheduled = queueForFormat(profile, format),
                  published = publishedForFormat(profile, format),
                  metric = twitterFormatProgress(published, scheduled),
                  total = metric.total,
                  progress = metric.progress;
                const reason = profile.queue.blocking_count
                  ? "Aguardando reconciliação"
                  : profile.available_micros < minimumCost
                    ? `Disponível ${usd(profile.available_micros)} · mínimo ${usd(minimumCost)}`
                    : `Disponível ${usd(profile.available_micros)}`;
                return (
                  <div
                    key={profile.id}
                    className={`${base.profileRow} ${selected ? base.profileRowActive : ""} ${!enabled ? styles.profileDisabled : ""}`}
                    role="checkbox"
                    aria-checked={selected}
                    aria-disabled={!enabled}
                    tabIndex={enabled ? 0 : -1}
                    title={`${reason}. Contábil ${usd(profile.posted_micros)}; reservado ${usd(profile.reserved_micros)}.`}
                    onClick={(event) => {
                      toggleProfile(profile, event.shiftKey);
                      if (enabled) event.currentTarget.focus();
                    }}
                    onKeyDown={(event) => {
                      if (
                        enabled &&
                        (event.key === " " || event.key === "Enter")
                      ) {
                        event.preventDefault();
                        toggleProfile(profile, event.shiftKey);
                      }
                    }}
                  >
                    <span className={base.profileCheckbox} aria-hidden="true">
                      {selected ? "✓" : ""}
                    </span>
                    {profile.avatar_url ? (
                      <img src={profile.avatar_url} alt="" />
                    ) : (
                      <span className={base.avatar}>
                        {profile.username.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className={base.profileIdentity}>
                      <strong>@{profile.username}</strong>
                      <small>
                        {profile.display_name ||
                          (profile.account_tier === "premium"
                            ? "Premium"
                            : "Free")}
                      </small>
                      <small
                        className={
                          enabled
                            ? styles.profileBalance
                            : styles.profileBlocked
                        }
                      >
                        {reason}
                        {(walletProfileCounts.get(profile.identity_id) ?? 0) > 1
                          ? " · compartilhada"
                          : ""}
                      </small>
                    </span>
                    <span
                      className={`${base.profileQueue} ${total === 0 ? base.profileQueueEmpty : ""}`}
                      title={`${published} publicadas de ${total}; ${scheduled} a postar em ${formatLabels[format]}`}
                    >
                      <strong>
                        {published}/{total}
                      </strong>
                      <span
                        className={base.profileProgressTrack}
                        aria-hidden="true"
                      >
                        <span style={{ width: `${progress}%` }} />
                      </span>
                    </span>
                  </div>
                );
              })
            )}
            {renderedProfiles.length < orderedProfiles.length ? (
              <button
                className={base.profileLoadMore}
                type="button"
                onClick={() =>
                  setRenderLimit((current) =>
                    bulkProfileRenderLimit(current, orderedProfiles.length),
                  )
                }
              >
                Mostrar mais perfis (
                {orderedProfiles.length - renderedProfiles.length})
              </button>
            ) : null}
          </div>
        </aside>
        <div className={base.configuration}>
          <section className={base.card}>
            <header>
              <strong>Configuração do lote</strong>
              <small>Nome, formato, origem única e janela móvel</small>
            </header>
            <div className={base.fieldGrid}>
              <label className={base.field}>
                Nome do programa *
                <input
                  maxLength={160}
                  value={name}
                  onChange={(event) => {
                    invalidate();
                    setName(event.target.value);
                  }}
                  placeholder="Ex.: campanha X de setembro"
                />
              </label>
              <label className={base.field}>
                Formato
                <select
                  value={format}
                  onChange={(event) =>
                    changeFormat(event.target.value as PostFormat)
                  }
                >
                  <option value="text">Somente texto</option>
                  <option value="images">Imagens</option>
                  <option value="gif">GIF</option>
                  <option value="video">Vídeo</option>
                </select>
                <small>
                  A métrica de cada perfil muda junto com o formato.
                </small>
              </label>
              {format !== "text" ? (
                <label className={`${base.field} ${base.wideField}`}>
                  Origem de mídia *
                  <select
                    value={originKey}
                    onChange={(event) => {
                      invalidate();
                      setOriginKey(event.target.value);
                      setSelectedAssets([]);
                      setImageSets([]);
                    }}
                  >
                    <option value="">Selecione uma origem</option>
                    <option value="ungrouped">Sem grupo</option>
                    {mediaGroups.map((group) => (
                      <option key={group.id} value={`group:${group.id}`}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                  <small>
                    {format === "images"
                      ? "Sem conjuntos, cada imagem da origem vira um post. Monte conjuntos apenas para publicar de 1 a 4 imagens juntas."
                      : `Todos os ${formatLabels[format]} elegíveis da origem serão usados; não é necessário selecionar um por um.`}
                  </small>
                </label>
              ) : null}
              <label className={`${base.field} ${base.wideField}`}>
                Esquema de horários
                <select
                  value={scheduleKind}
                  onChange={(event) => {
                    invalidate();
                    setScheduleKind(event.target.value as "interval" | "daily");
                  }}
                >
                  <option value="interval">Intervalo contínuo</option>
                  <option value="daily">Uma vez por dia em horário fixo</option>
                </select>
                <small>
                  {scheduleKind === "interval"
                    ? "Acumula depois da cauda ativa de cada perfil."
                    : "Mantém o horário civil de America/Sao_Paulo."}
                </small>
              </label>
              {scheduleKind === "interval" ? (
                <>
                  <label className={base.field}>
                    Intervalo (minutos)
                    <input
                      type="number"
                      min="1"
                      value={intervalMinutes}
                      onChange={(event) => {
                        invalidate();
                        setIntervalMinutes(Number(event.target.value));
                      }}
                    />
                  </label>
                  <label className={base.field}>
                    Duração (dias de 24h)
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={durationDays}
                      onChange={(event) => {
                        invalidate();
                        setDurationDays(Number(event.target.value));
                      }}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className={base.field}>
                    Horário diário
                    <input
                      type="time"
                      value={dailyTime}
                      onChange={(event) => {
                        invalidate();
                        setDailyTime(event.target.value);
                      }}
                    />
                  </label>
                  <label className={base.field}>
                    Quantidade de dias
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={days}
                      onChange={(event) => {
                        invalidate();
                        setDays(Number(event.target.value));
                      }}
                    />
                  </label>
                </>
              )}
              <label className={`${base.field} ${base.wideField}`}>
                Ordem da rotação
                <select
                  value={orderMode}
                  onChange={(event) => {
                    invalidate();
                    setOrderMode(event.target.value as BulkRotationOrderMode);
                  }}
                >
                  <option value="diversified">
                    Diversificada e determinística
                  </option>
                  <option value="same_order">
                    Mesma ordem em todos os perfis
                  </option>
                </select>
                <small>
                  Vale para imagens individuais, conjuntos, GIFs, vídeos e
                  combinações com textos. Todas as combinações são usadas antes
                  de repetir.
                </small>
              </label>
            </div>
          </section>
          <section className={base.card}>
            <header>
              <div>
                <strong>Alternativas de texto</strong>
                <small>
                  {format === "text"
                    ? "Obrigatório para postagem somente texto"
                    : "Opcional — deixe vazio para publicar somente a mídia"}
                </small>
              </div>
              <button
                className={base.subtleButton}
                type="button"
                disabled={texts.length >= 50}
                onClick={() => setTexts((current) => [...current, ""])}
              >
                ＋ Adicionar texto
              </button>
            </header>
            <div className={styles.textList}>
              {texts.map((text, index) => {
                const weighted = countTwitterWeightedCharacters(text),
                  hasUrl = containsHttpUrl(text),
                  valid =
                    !text.trim() ||
                    selectedProfiles.every(
                      (profile) =>
                        weighted <=
                        getTwitterCharacterLimit(profile.account_tier),
                    );
                return (
                  <div
                    className={`${styles.textItem} ${valid ? "" : styles.textInvalid}`}
                    key={index}
                  >
                    <div className={styles.textItemHeader}>
                      <strong>Texto {index + 1}</strong>
                      <span>
                        {weighted} caracteres ponderados ·{" "}
                        {hasUrl ? `${usd(200_000)} com URL` : usd(15_000)}
                      </span>
                      {texts.length > 1 ? (
                        <button
                          type="button"
                          onClick={() => {
                            invalidate();
                            setTexts((current) =>
                              current.filter(
                                (_, currentIndex) => currentIndex !== index,
                              ),
                            );
                          }}
                        >
                          Remover
                        </button>
                      ) : null}
                    </div>
                    <textarea
                      value={text}
                      onChange={(event) =>
                        updateText(index, event.target.value)
                      }
                      onPaste={(event) => pasteTextList(index, event)}
                      placeholder={
                        format === "text"
                          ? "Digite ou cole o texto desta alternativa"
                          : "Legenda opcional para acompanhar a mídia"
                      }
                    />
                    <small>
                      Ao colar várias linhas do Excel, os campos abertos abaixo
                      são preenchidos em ordem; linhas excedentes são ignoradas.
                    </small>
                  </div>
                );
              })}
            </div>
          </section>
          {format !== "text" ? (
            <section className={base.card}>
              <header>
                <strong>Mídias da origem</strong>
                <small>
                  {format === "images"
                    ? imageSets.length
                      ? "Os conjuntos manuais abaixo serão as unidades da rotação"
                      : "Cada imagem da origem será uma unidade da rotação"
                    : "Origem completa, sem seleção manual"}
                </small>
              </header>
              {!originKey ? (
                <p className={base.empty}>
                  Selecione uma origem para visualizar as mídias compatíveis.
                </p>
              ) : !originAssets.length ? (
                <div className={base.empty}><p>Nenhuma mídia compatível carregada nesta origem.</p>{mediaHasMore?<button type="button" className="button button-ghost" disabled={loadingMedia} onClick={()=>void loadMoreMedia()}>{loadingMedia?'Carregando mídias…':'Buscar mais mídias'}</button>:null}</div>
              ) : (
                <>
                  <div className={styles.mediaSummary}>
                    <span>
                      <b>{originAssets.length}</b> compatíveis
                    </span>
                    <span>
                      <b>{effectiveMediaSets.length}</b> conjuntos na rotação
                    </span>
                    <span>
                      <b>{formatLabels[format]}</b>
                    </span>
                  </div>
                  <div className={base.thumbnailGrid}>
                    {originAssets.map((asset, index) => {
                      const selected = selectedAssets.includes(asset.id);
                      return (
                        <figure
                          key={asset.id}
                          className={selected ? styles.mediaSelected : ""}
                          onClick={() => {
                            if (format !== "images") return;
                            setSelectedAssets((current) =>
                              current.includes(asset.id)
                                ? current.filter((id) => id !== asset.id)
                                : current.length < 4
                                  ? [...current, asset.id]
                                  : current,
                            );
                          }}
                          title={asset.original_name}
                        >
                          {asset.signed_url ? (
                            asset.media_kind === "video" ? (
                              <video
                                src={asset.signed_url}
                                muted
                                preload="metadata"
                              />
                            ) : (
                              <img
                                src={asset.signed_url}
                                alt={asset.original_name}
                                loading="lazy"
                              />
                            )
                          ) : (
                            <span>{asset.media_kind.toUpperCase()}</span>
                          )}
                          <figcaption>
                            {format === "images" && selected ? "✓" : index + 1}
                          </figcaption>
                        </figure>
                      );
                    })}
                  </div>
                  {mediaHasMore?<button type="button" className="button button-ghost" disabled={loadingMedia} onClick={()=>void loadMoreMedia()}>{loadingMedia?'Carregando mídias…':'Carregar mais mídias'}</button>:null}
                  {format === "images" ? (
                    <>
                      <div className={styles.mediaBuilder}>
                        <p>
                          {selectedAssets.length}/4 imagens selecionadas para o
                          próximo conjunto
                        </p>
                        <button
                          className={base.subtleButton}
                          type="button"
                          disabled={!selectedAssets.length}
                          onClick={addImageSet}
                        >
                          Adicionar conjunto
                        </button>
                      </div>
                      <p className={styles.originRule}>
                        {imageSets.length
                          ? "Há conjuntos manuais: somente eles serão publicados e cada conjunto formará um post."
                          : "Nenhum conjunto manual: todas as imagens compatíveis serão publicadas uma a uma."}
                      </p>
                    </>
                  ) : (
                    <p className={styles.originRule}>
                      Cada arquivo compatível vira um conjunto e todos
                      participam da rotação determinística.
                    </p>
                  )}
                </>
              )}
              {format === "images" && imageSets.length ? (
                <div className={styles.setList}>
                  {imageSets.map((set, index) => (
                    <div key={set.clientKey}>
                      <span>
                        <strong>Conjunto {index + 1}</strong> ·{" "}
                        {set.assetIds.length} imagem(ns)
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          invalidate();
                          setImageSets((current) =>
                            current.filter(
                              (item) => item.clientKey !== set.clientKey,
                            ),
                          );
                        }}
                      >
                        Remover
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
          <section className={base.projection} aria-label="Projeção compacta">
            <div>
              <span>Perfis</span>
              <strong>{profileSelection.ids.length}</strong>
            </div>
            <div>
              <span>Bloqueados visíveis</span>
              <strong>{blockedVisible}</strong>
            </div>
            <div>
              <span>Slots por perfil</span>
              <strong>{slots}</strong>
            </div>
            <div>
              <span>Publicações</span>
              <strong>{projected}</strong>
            </div>
            <div>
              <span>Textos</span>
              <strong>{usableTexts.length}</strong>
            </div>
            <div>
              <span>Conjuntos</span>
              <strong>
                {effectiveMediaSets.length || (format === "text" ? "Texto" : 0)}
              </strong>
            </div>
            <div>
              <span>Saldo único</span>
              <strong>{usd(selectedBalance)}</strong>
            </div>
            <div>
              <span>Custo mínimo</span>
              <strong>{usd(minimumCost)}</strong>
            </div>
          </section>
          <div className={base.reviewAction}>
            <p>
              A projeção é estimada. A revisão recalcula fila, carteira
              compartilhada, custos e horários sem reservar saldo.
            </p>
            <button
              className="button button-secondary"
              type="button"
              disabled={busy !== null || !canReview}
              onClick={() => void doReview()}
            >
              {busy === "review" ? "Revisando…" : "Revisar custos e horários"}
            </button>
          </div>
        </div>
      </div>
      {review ? (
        <div
          className={base.modalBackdrop}
          role="presentation"
          onMouseDown={() => (busy ? null : setReview(null))}
        >
          <section
            className={`${base.reviewModal} ${styles.reviewWide}`}
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="section-kicker">Confirmação financeira X</span>
                <h3>{review.name}</h3>
                <p>Nenhuma reserva foi criada até este momento.</p>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setReview(null)}
              >
                ×
              </button>
            </header>
            <dl className={base.reviewGrid}>
              <div>
                <dt>Primeira execução</dt>
                <dd>{date(review.schedule.first)}</dd>
              </div>
              <div>
                <dt>Última execução</dt>
                <dd>{date(review.schedule.last)}</dd>
              </div>
              <div>
                <dt>Solicitadas</dt>
                <dd>{review.totalRequested}</dd>
              </div>
              <div>
                <dt>Financiáveis</dt>
                <dd>{review.fundedCount}</dd>
              </div>
              <div>
                <dt>Sem saldo</dt>
                <dd>{review.unfundedCount}</dd>
              </div>
              <div>
                <dt>Reserva</dt>
                <dd>{usd(review.reservedMicros)}</dd>
              </div>
              {review.costBreakdown.map((cost) => (
                <div key={cost.category}>
                  <dt>
                    {cost.category === "post_create_url"
                      ? "Com URL"
                      : "Sem URL"}{" "}
                    · {cost.count}
                  </dt>
                  <dd>{usd(cost.totalMicros)}</dd>
                </div>
              ))}
              {review.typeBreakdown.map((item) => (
                <div key={item.type}>
                  <dt>{typeLabels[item.type]}</dt>
                  <dd>{item.count}</dd>
                </div>
              ))}
            </dl>
            <section className={styles.reviewSection}>
              <div className={styles.reviewSectionHeader}>
                <div>
                  <h4>Perfis e saldos</h4>
                  <small>
                    {reviewProfileRows.length} perfis · {review.walletSnapshots.length}{" "}
                    {review.walletSnapshots.length === 1 ? "carteira" : "carteiras"}
                  </small>
                </div>
                <small>Ordem alfabética</small>
              </div>
              <div
                className={styles.profileFinanceList}
                aria-label="Perfis, carteiras e saldos da programação"
              >
                {reviewProfileRows.map(
                  ({ shortfall, profile, wallet, walletProfileCount }) => (
                    <article
                      className={styles.profileFinanceRow}
                      key={shortfall.profile_id}
                    >
                      <header className={styles.profileFinanceIdentity}>
                        {profile?.avatar_url ? (
                          <img src={profile.avatar_url} alt="" />
                        ) : (
                          <span className={styles.financeAvatar} aria-hidden="true">
                            {(profile?.username ?? shortfall.profile_id)
                              .slice(0, 1)
                              .toUpperCase()}
                          </span>
                        )}
                        <div>
                          <strong>
                            @{profile?.username ?? shortfall.profile_id.slice(0, 8)}
                          </strong>
                          <small>{profile?.display_name || "Perfil X"}</small>
                          <small>
                            {wallet
                              ? `Carteira ${wallet.number}${walletProfileCount > 1 ? ` · compartilhada por ${walletProfileCount} perfis` : ""}`
                              : "Carteira não identificada"}
                          </small>
                        </div>
                        <span className={styles.financeStatus}>
                          <b>{shortfall.funded_count}</b> financiadas
                          <small>{shortfall.unfunded_count} sem saldo</small>
                        </span>
                      </header>
                      <dl className={styles.profileBalanceGrid}>
                        <div>
                          <dt>Contábil</dt>
                          <dd>{wallet ? usd(wallet.postedMicros) : "—"}</dd>
                        </div>
                        <div>
                          <dt>Disponível agora</dt>
                          <dd>{wallet ? usd(wallet.availableMicros) : "—"}</dd>
                        </div>
                        <div>
                          <dt>Já reservado</dt>
                          <dd>{wallet ? usd(wallet.reservedMicros) : "—"}</dd>
                        </div>
                        <div>
                          <dt>Este programa</dt>
                          <dd>
                            {wallet ? usd(wallet.programReservationMicros) : "—"}
                          </dd>
                        </div>
                        <div>
                          <dt>Saldo final</dt>
                          <dd>
                            {wallet ? usd(wallet.projectedAvailableMicros) : "—"}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ),
                )}
              </div>
            </section>
            {review.warnings.length ? (
              <section className={styles.reviewSection}>
                <h4>Avisos</h4>
              {review.warnings.map((warning, index) => (
                <p
                  className={styles.warning}
                  key={`${warning.profileId}-${index}`}
                >
                  {warning.message}
                </p>
              ))}
              </section>
            ) : null}
            <footer>
              <button
                className={base.subtleButton}
                type="button"
                disabled={busy !== null}
                onClick={() => setReview(null)}
              >
                Voltar e editar
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy !== null || review.fundedCount < 1}
                onClick={() => void confirm()}
              >
                {busy === "confirm" ? "Confirmando…" : "Confirmar programação"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
