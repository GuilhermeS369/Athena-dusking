"use client";

import Link from "next/link";
import {
  ChangeEvent,
  MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { fingerprintMediaFile } from "@/lib/gallery/file-fingerprint";
import { galleryPageState } from "@/lib/gallery/pagination";
import { uploadTwitterMediaResumable } from "@/lib/twitter/resumable-upload";
import {
  createGifThumbnail,
  createRealVideoThumbnail,
  createVideoFallbackThumbnail,
} from "./video-thumbnail";

type Organization = {
  id: string;
  name: string;
  role: "admin" | "operator" | "viewer";
};
type Asset = {
  id: string;
  original_name: string;
  mime_type: string;
  kind: "image" | "gif" | "video";
  size_bytes: number;
  status: "uploaded" | "processing" | "ready" | "failed" | "deleted";
  processing_error: string | null;
  signed_url: string | null;
  thumbnail_url?: string | null;
  group_ids?: string[];
  first_published_at: string | null;
  publication_state?: {
    scheduled_count: number;
    next_scheduled_at: string | null;
  } | null;
  created_at: string;
};
type Group = {
  id: string;
  name: string;
  consumption_mode?: "single_use" | "reusable";
};
type Assignment = { media_asset_id: string; group_id: string };
type UploadStatus =
  | "preparing"
  | "queued"
  | "retrying"
  | "uploading"
  | "completed"
  | "duplicate"
  | "failed"
  | "cancelled";
type MessageTone = "success" | "neutral" | "error";
type GallerySituationFilter =
  | "all"
  | "schedulable"
  | "unposted"
  | "scheduled"
  | "posted"
  | "posted_scheduled"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed";
type UploadItem = {
  id: string;
  file: File;
  thumbnail?: File;
  groupId?: string;
  status: UploadStatus;
  loaded: number;
  speed: number;
  eta: number | null;
  error: string | null;
  attempts: number;
  checksum?: string;
  readyForUpload: boolean;
};
type MediaPage = {
  assets: Asset[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number;
};

const GALLERY_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function normalizeGalleryFileMime(file: File, accepted: Set<string>) {
  if (accepted.has(file.type)) return file;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const inferredType = GALLERY_MIME_BY_EXTENSION[extension];
  if (!inferredType || !accepted.has(inferredType)) return file;
  return new File([file], file.name, {
    type: inferredType,
    lastModified: file.lastModified,
  });
}

type DeleteMediaPayload = {
  deletedIds?: string[];
  affectedItemIds?: string[];
  affectedBatchIds?: string[];
  queued?: boolean;
  queuedAssetIds?: string[];
  job?: { id: string; totalCount: number };
  error?: string;
  warning?: string;
};

type MediaDeletionJob = {
  id: string;
  status:
    | "pending"
    | "processing"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "cancelled";
  total_count: number;
  processed_count: number;
  deleted_count: number;
  affected_item_count: number;
  failed_count: number;
  last_error_message: string | null;
  failure_details?: MediaDeletionJobDetail[];
  warning_details?: MediaDeletionJobDetail[];
};

type MediaDeletionJobDetail = {
  mediaAssetId: string;
  originalName: string | null;
  status: "deleted" | "failed";
  message: string;
  processedAt: string | null;
};

type MediaGroupAssignmentJob = {
  id: string;
  action: "add" | "remove" | "replace";
  status:
    | "pending"
    | "processing"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "cancelled";
  total_count: number;
  processed_count: number;
  applied_count: number;
  skipped_count: number;
  failed_count: number;
  last_error_message: string | null;
};

const MAX_CONCURRENT_UPLOADS = 2;
const MAX_CONCURRENT_PREPARATIONS = 1;
const MAX_UPLOAD_ATTEMPTS = 5;
const MAX_COMPLETION_ATTEMPTS = 5;
// A imagem fallback já é enviada junto com o vídeo. A extração do frame real é
// apenas um refinamento e não deve monopolizar o navegador nem atrasar os demais
// itens de upload caso um codec específico não responda.
const MAX_BACKGROUND_THUMBNAIL_ATTEMPTS = 1;
const MAX_CONCURRENT_BACKGROUND_THUMBNAILS = 1;
const UPLOAD_PROGRESS_INTERVAL_MS = 250;
const UPLOAD_RETRY_BASE_DELAY_MS = 3_000;
const UPLOAD_RETRY_MAX_DELAY_MS = 30_000;
const THUMBNAIL_RECOVERY_DOWNLOAD_TIMEOUT_MS = 90_000;
const QUEUE_PREVIEW_SIZE = 16;

type ThumbnailRecoveryFailure = { name: string; message: string };
type ThumbnailRecovery = {
  phase: "scanning" | "recovering" | "completed";
  scanned: number;
  discovered: number;
  processed: number;
  recovered: number;
  failures: ThumbnailRecoveryFailure[];
};

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(value: number, active = true) {
  if (!active) return "—";
  return value > 0 ? `${formatBytes(value)}/s` : "medindo velocidade…";
}

function formatEta(seconds: number | null, active = true) {
  if (!active) return "—";
  if (seconds === null || !Number.isFinite(seconds)) return "estimando tempo…";
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s restantes`;
  return `${Math.floor(seconds / 60)}min ${Math.ceil(seconds % 60)}s restantes`;
}

function statusLabel(status: UploadStatus) {
  return {
    preparing: "Preparando",
    queued: "Aguardando",
    retrying: "Tentando novamente",
    uploading: "Enviando agora",
    completed: "Concluído",
    duplicate: "Já existente",
    failed: "Falhou",
    cancelled: "Cancelado",
  }[status];
}

function retryDelayMs(attempt: number) {
  return Math.min(
    UPLOAD_RETRY_MAX_DELAY_MS,
    UPLOAD_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function waitUntilOnline() {
  if (typeof navigator === "undefined" || navigator.onLine)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    window.addEventListener("online", () => resolve(), { once: true });
  });
}

function shouldRetryHttpStatus(status: number) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function isLikelyTemporaryUploadError(error: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error ?? "").toLowerCase();
  return [
    "network",
    "fetch",
    "timeout",
    "tempor",
    "conex",
    "failed to fetch",
    "load failed",
  ].some((term) => message.includes(term));
}

function deletionJobReviewMessage(job: MediaDeletionJob) {
  if (job.failure_details?.[0]?.message) return job.failure_details[0].message;
  if (job.last_error_message) return job.last_error_message;
  if (job.failed_count)
    return "O worker registrou falhas por mídia. Abra os detalhes abaixo para ver quais arquivos precisam de nova tentativa.";
  return null;
}

export default function GalleryClient({
  activeOrganization,
  assets: initialAssets,
  initialHasMoreAssets,
  initialNextCursor,
  initialTotal,
  groups: initialGroups,
  assignments: initialAssignments,
  platform = "instagram",
}: {
  activeOrganization: Organization;
  assets: Asset[];
  initialHasMoreAssets: boolean;
  initialNextCursor: string | null;
  initialTotal: number;
  groups: Group[];
  assignments: Assignment[];
  platform?: "instagram" | "twitter";
}) {
  const isTwitter = platform === "twitter";
  const mediaApi = isTwitter ? "/api/x/media" : "/api/media";
  const mediaBucket = isTwitter ? "twitter-media" : "instagram-media";
  const maxFileSize = isTwitter ? 512 * 1024 * 1024 : 50 * 1024 * 1024;
  const acceptedMimeTypes = isTwitter
    ? "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
    : "image/jpeg,image/png,image/webp,video/mp4,video/quicktime";
  const acceptedMimeSet = new Set(acceptedMimeTypes.split(","));
  const canManage = ["admin", "operator"].includes(activeOrganization.role);
  const inputRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<UploadItem[]>([]);
  const activeUploadsRef = useRef(0);
  const activePreparationsRef = useRef(0);
  const preparingIdsRef = useRef(new Set<string>());
  const thumbnailGenerationRef = useRef(new Set<string>());
  const backgroundThumbnailQueueRef = useRef<
    Array<{ assetId: string; file: File }>
  >([]);
  const activeBackgroundThumbnailsRef = useRef(0);
  const requestsRef = useRef(new Map<string, XMLHttpRequest>());
  const resumableRequestsRef = useRef(new Map<string, AbortController>());
  const cancelledRef = useRef(new Set<string>());
  const [assets, setAssets] = useState(initialAssets);
  const [groups] = useState(initialGroups);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [uploadQueueExpanded, setUploadQueueExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<MessageTone>("neutral");
  const [assignments, setAssignments] = useState(initialAssignments);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<
    "all" | "image" | "gif" | "video"
  >("all");
  const [statusFilter, setStatusFilter] =
    useState<GallerySituationFilter>("all");
  const [groupFilter, setGroupFilter] = useState<"all" | "none" | string>(
    "all",
  );
  const [view, setView] = useState<"grid" | "list" | "groups">("grid");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<"add" | "remove" | "replace">(
    "add",
  );
  const [bulkGroupIds, setBulkGroupIds] = useState<string[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectingFilter, setSelectingFilter] = useState(false);
  const [allFilterSelected, setAllFilterSelected] = useState(false);
  const [filterSelectedTotal, setFilterSelectedTotal] = useState(0);
  const [activeDeletionJob, setActiveDeletionJob] =
    useState<MediaDeletionJob | null>(null);
  const [activeGroupAssignmentJob, setActiveGroupAssignmentJob] =
    useState<MediaGroupAssignmentJob | null>(null);
  const [uploadGroupId, setUploadGroupId] = useState("");
  const [loadingFilter, setLoadingFilter] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreAssets, setHasMoreAssets] = useState(initialHasMoreAssets);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [totalAssets, setTotalAssets] = useState(initialTotal);
  const [mediaRevision, setMediaRevision] = useState(0);
  const filtersInitializedRef = useRef(false);
  const filterRequestRef = useRef(0);
  const mediaPageCacheRef = useRef(new Map<string, MediaPage>());
  const selectionAnchorIdRef = useRef<string | null>(null);
  const gallerySentinelRef = useRef<HTMLDivElement>(null);
  const [paginationIssue, setPaginationIssue] = useState("");
  const [thumbnailRecovery, setThumbnailRecovery] =
    useState<ThumbnailRecovery | null>(null);

  function replaceQueue(updater: (current: UploadItem[]) => UploadItem[]) {
    const next = updater(queueRef.current);
    queueRef.current = next;
    setQueue(next);
  }

  function showMessage(nextMessage: string, tone: MessageTone = "neutral") {
    setMessage(nextMessage);
    setMessageTone(tone);
  }

  function deleteMessage(
    deletedCount: number,
    affectedCount: number,
    fallback?: string,
  ) {
    if (fallback) return fallback;
    const mediaText =
      deletedCount === 1
        ? "Mídia apagada."
        : `${deletedCount} mídias apagadas.`;
    if (!affectedCount) return mediaText;
    const itemText =
      affectedCount === 1
        ? "1 publicação foi marcada como “Mídia apagada” e não será executada."
        : `${affectedCount} publicações foram marcadas como “Mídia apagada” e não serão executadas.`;
    return `${mediaText} ${itemText}`;
  }

  async function uploadRealThumbnail(
    assetId: string,
    thumbnail: File,
    recovery = false,
  ) {
    const body = new FormData();
    body.set("thumbnail", thumbnail);
    const response = await fetch(`${mediaApi}/${assetId}/thumbnail`, {
      method: "POST",
      body,
      headers: recovery ? { "X-Thumbnail-Recovery": "true" } : undefined,
    });
    const payload = (await response.json()) as {
      thumbnail_url?: string | null;
      error?: string;
    };
    if (!response.ok)
      throw new Error(
        payload.error ?? "Não foi possível atualizar a miniatura real.",
      );
    if (payload.thumbnail_url) {
      setAssets((current) =>
        current.map((asset) =>
          asset.id === assetId
            ? { ...asset, thumbnail_url: payload.thumbnail_url }
            : asset,
        ),
      );
      invalidateMediaPages();
    }
  }

  function pumpBackgroundThumbnailQueue() {
    while (
      activeBackgroundThumbnailsRef.current <
      MAX_CONCURRENT_BACKGROUND_THUMBNAILS
    ) {
      const task = backgroundThumbnailQueueRef.current.shift();
      if (!task) return;
      activeBackgroundThumbnailsRef.current += 1;
      void (async () => {
        for (
          let attempt = 1;
          attempt <= MAX_BACKGROUND_THUMBNAIL_ATTEMPTS;
          attempt += 1
        ) {
          try {
            const thumbnail = await createRealVideoThumbnail(task.file);
            await uploadRealThumbnail(task.assetId, thumbnail);
            return;
          } catch (error) {
            console.warn(
              `[gallery] Miniatura real falhou para ${task.file.name}; tentativa ${attempt}/${MAX_BACKGROUND_THUMBNAIL_ATTEMPTS}.`,
              error,
            );
          }
        }
        // O fallback já foi persistido antes do vídeo. Mantê-lo evita que uma
        // falha de decoder deixe a mídia sem preview ou bloqueie a fila.
        showMessage(
          `O vídeo “${task.file.name}” ficou com a miniatura temporária porque o navegador não conseguiu extrair um frame real.`,
          "error",
        );
      })().finally(() => {
        thumbnailGenerationRef.current.delete(task.assetId);
        activeBackgroundThumbnailsRef.current -= 1;
        pumpBackgroundThumbnailQueue();
      });
    }
  }

  function generateRealThumbnailInBackground(assetId: string, file: File) {
    if (
      !file.type.startsWith("video/") ||
      thumbnailGenerationRef.current.has(assetId)
    )
      return;
    thumbnailGenerationRef.current.add(assetId);
    backgroundThumbnailQueueRef.current.push({ assetId, file });
    pumpBackgroundThumbnailQueue();
  }

  function updateQueueItem(
    id: string,
    updater: (item: UploadItem) => UploadItem,
  ) {
    replaceQueue((current) =>
      current.map((item) => (item.id === id ? updater(item) : item)),
    );
  }

  function yieldToBrowser() {
    return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  function groupIdsFor(asset: Asset | string) {
    if (typeof asset !== "string" && asset.group_ids) return asset.group_ids;
    const assetId = typeof asset === "string" ? asset : asset.id;
    return assignments
      .filter((assignment) => assignment.media_asset_id === assetId)
      .map((assignment) => assignment.group_id);
  }

  function assetMatchesSituation(asset: Asset) {
    const scheduled = Boolean(asset.publication_state?.scheduled_count);
    const posted = Boolean(asset.first_published_at);
    switch (statusFilter) {
      case "all":
        return true;
      case "schedulable":
        return asset.status === "ready" && !posted && !scheduled;
      case "unposted":
        return !posted && !scheduled;
      case "scheduled":
        return scheduled;
      case "posted":
        return posted;
      case "posted_scheduled":
        return posted && scheduled;
      case "uploaded":
      case "processing":
      case "ready":
      case "failed":
        return asset.status === statusFilter;
      default:
        return true;
    }
  }

  function assetMatchesActiveFilters(
    asset: Asset,
    currentAssignments = assignments,
  ) {
    const matchesSearch =
      !debouncedSearch.trim() ||
      asset.original_name
        .toLowerCase()
        .includes(debouncedSearch.trim().toLowerCase());
    const matchesType = typeFilter === "all" || asset.kind === typeFilter;
    const matchesStatus = assetMatchesSituation(asset);
    const assetGroups =
      asset.group_ids ??
      currentAssignments
        .filter((assignment) => assignment.media_asset_id === asset.id)
        .map((assignment) => assignment.group_id);
    const matchesGroup =
      groupFilter === "all" ||
      (groupFilter === "none"
        ? assetGroups.length === 0
        : assetGroups.includes(groupFilter));
    return matchesSearch && matchesType && matchesStatus && matchesGroup;
  }

  function invalidateMediaPages() {
    mediaPageCacheRef.current.clear();
  }

  function refreshActiveMedia() {
    invalidateMediaPages();
    setMediaRevision((current) => current + 1);
  }

  function revealAsset(asset: Asset, countAsNew = false) {
    if (!assetMatchesActiveFilters(asset)) return false;
    setAssets((current) => {
      const alreadyLoaded = current.some((item) => item.id === asset.id);
      if (!alreadyLoaded && countAsNew) setTotalAssets((total) => total + 1);
      return [asset, ...current.filter((item) => item.id !== asset.id)];
    });
    invalidateMediaPages();
    return true;
  }

  function addUploadedAsset(asset: Asset, duplicated = false) {
    const revealed = revealAsset(asset, !duplicated);
    if (!revealed || duplicated) refreshActiveMedia();
  }

  function finishUploadedAsset(asset: Asset, file: File, duplicated = false) {
    addUploadedAsset(asset, duplicated);
    if (!duplicated && asset.kind === "video")
      generateRealThumbnailInBackground(asset.id, file);
  }

  async function retryLater(
    item: UploadItem,
    reason: string,
    nextAttempt: number,
  ) {
    const delay = retryDelayMs(nextAttempt);
    updateQueueItem(item.id, (current) =>
      current.status === "cancelled"
        ? current
        : {
            ...current,
            status: "retrying",
            speed: 0,
            eta: null,
            error: `${reason} Tentando novamente em ${Math.ceil(delay / 1000)}s (${nextAttempt}/${MAX_UPLOAD_ATTEMPTS}).`,
          },
    );
    await waitUntilOnline();
    await wait(delay);
    updateQueueItem(item.id, (current) =>
      current.status === "retrying"
        ? {
            ...current,
            status: "queued",
            readyForUpload: true,
            loaded: 0,
            speed: 0,
            eta: null,
          }
        : current,
    );
  }

  async function completeDirectUploadWithRetry(
    item: UploadItem,
    storagePath: string,
    thumbnailStoragePath: string | null,
  ) {
    for (let attempt = 1; attempt <= MAX_COMPLETION_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`${mediaApi}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storagePath,
            thumbnailStoragePath,
            originalName: item.file.name,
            mimeType: item.file.type,
            sizeBytes: item.file.size,
            checksum: item.checksum,
            groupId: item.groupId ?? null,
          }),
        });
        const payload = (await response.json()) as {
          asset?: Asset;
          error?: string;
          duplicated?: boolean;
        };
        if (response.ok && payload.asset) return payload;
        if (
          !shouldRetryHttpStatus(response.status) ||
          attempt === MAX_COMPLETION_ATTEMPTS
        )
          throw new Error(
            payload.error ??
              "O arquivo subiu, mas não foi registrado na galeria.",
          );
        updateQueueItem(item.id, (current) =>
          current.status === "uploading"
            ? {
                ...current,
                error: `Arquivo enviado. Registro no banco falhou temporariamente; tentando novamente (${attempt + 1}/${MAX_COMPLETION_ATTEMPTS}).`,
              }
            : current,
        );
      } catch (error) {
        if (
          attempt === MAX_COMPLETION_ATTEMPTS ||
          !isLikelyTemporaryUploadError(error)
        )
          throw error;
        updateQueueItem(item.id, (current) =>
          current.status === "uploading"
            ? {
                ...current,
                error: `Arquivo enviado. Aguardando conexão para registrar no banco (${attempt + 1}/${MAX_COMPLETION_ATTEMPTS}).`,
              }
            : current,
        );
      }
      await waitUntilOnline();
      await wait(retryDelayMs(attempt));
    }

    throw new Error("O arquivo subiu, mas não foi registrado na galeria.");
  }

  async function uploadTwitterFile(item: UploadItem) {
    const storagePath = `${activeOrganization.id}/${item.id}-${item.file.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
    const thumbnailStoragePath = item.thumbnail
      ? `${activeOrganization.id}/thumbnails/${item.id}.jpg`
      : null;
    const controller = new AbortController();
    resumableRequestsRef.current.set(item.id, controller);
    let lastLoaded = 0;
    let lastTime = Date.now();
    try {
      if (item.thumbnail && thumbnailStoragePath) {
        const client = createSupabaseBrowserClient();
        const { error } = await client.storage
          .from("twitter-media")
          .upload(thumbnailStoragePath, item.thumbnail, {
            contentType: "image/jpeg",
            upsert: true,
          });
        if (error)
          throw new Error(
            `Não foi possível enviar a miniatura: ${error.message}`,
          );
      }
      await uploadTwitterMediaResumable({
        file: item.file,
        storagePath,
        signal: controller.signal,
        onProgress: (progress) => {
          const now = Date.now();
          const loaded = Math.round(progress * item.file.size);
          const seconds = Math.max(0.001, (now - lastTime) / 1000);
          const speed = Math.max(0, (loaded - lastLoaded) / seconds);
          const remaining = Math.max(0, item.file.size - loaded);
          lastLoaded = loaded;
          lastTime = now;
          updateQueueItem(item.id, (current) => ({
            ...current,
            loaded,
            speed,
            eta: speed > 0 ? remaining / speed : null,
          }));
        },
      });
      const completion = await completeDirectUploadWithRetry(
        item,
        storagePath,
        thumbnailStoragePath,
      );
      updateQueueItem(item.id, (current) => ({
        ...current,
        loaded: item.file.size,
        speed: 0,
        eta: 0,
        status: completion.duplicated ? "duplicate" : "completed",
        error: null,
      }));
      finishUploadedAsset(
        completion.asset!,
        item.file,
        Boolean(completion.duplicated),
      );
      await assignUploadedAssetToGroup(
        completion.asset!.id,
        completion.asset!,
        item.groupId,
      );
    } catch (error) {
      if (controller.signal.aborted || cancelledRef.current.has(item.id)) {
        updateQueueItem(item.id, (current) => ({
          ...current,
          status: "cancelled",
          error: null,
        }));
      } else if (
        item.attempts < MAX_UPLOAD_ATTEMPTS &&
        isLikelyTemporaryUploadError(error)
      ) {
        await retryLater(
          item,
          "Upload retomável do X foi interrompido.",
          item.attempts + 1,
        );
      } else {
        updateQueueItem(item.id, (current) => ({
          ...current,
          status: "failed",
          error: `Motivo da falha: ${error instanceof Error ? error.message : "não foi possível concluir o upload retomável."}`,
        }));
      }
    } finally {
      resumableRequestsRef.current.delete(item.id);
    }
  }

  function uploadFile(item: UploadItem) {
    if (isTwitter) return uploadTwitterFile(item);
    return new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      const startedAt = Date.now();
      let lastLoaded = 0;
      let lastTime = startedAt;
      let lastProgressRenderAt = startedAt;
      requestsRef.current.set(item.id, xhr);
      // Todo upload vai direto do navegador para o Supabase Storage. A API Next
      // fica responsável apenas por validar e registrar metadados, evitando
      // consumir banda/duração serverless com o corpo binário do arquivo.
      const useDirectStorage = true;
      const storagePath = `${activeOrganization.id}/${item.id}-${item.file.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      const thumbnailStoragePath = item.thumbnail
        ? `${activeOrganization.id}/thumbnails/${item.id}.jpg`
        : null;
      const startUpload = () => {
        xhr.open(
          "POST",
          useDirectStorage
            ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/${mediaBucket}/${storagePath}`
            : mediaApi,
        );
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          const now = Date.now();
          const elapsed = Math.max(1, now - lastTime) / 1000;
          const instantSpeed = (event.loaded - lastLoaded) / elapsed;
          const speed = instantSpeed > 0 ? instantSpeed : 0;
          const remaining = Math.max(0, event.total - event.loaded);
          lastLoaded = event.loaded;
          lastTime = now;
          if (
            event.loaded < event.total &&
            now - lastProgressRenderAt < UPLOAD_PROGRESS_INTERVAL_MS
          )
            return;
          updateQueueItem(item.id, (current) => ({
            ...current,
            loaded: event.loaded,
            speed,
            eta: speed > 0 ? remaining / speed : null,
          }));
          lastProgressRenderAt = now;
        };
        xhr.onload = () => {
          requestsRef.current.delete(item.id);
          let payload: { asset?: Asset; error?: string; duplicated?: boolean } =
            {};
          try {
            payload = JSON.parse(xhr.responseText) as typeof payload;
          } catch {
            /* resposta inválida tratada abaixo */
          }
          if (useDirectStorage && xhr.status >= 200 && xhr.status < 300) {
            void completeDirectUploadWithRetry(
              item,
              storagePath,
              thumbnailStoragePath,
            )
              .then((completion) => {
                updateQueueItem(item.id, (current) => ({
                  ...current,
                  loaded: item.file.size,
                  speed: 0,
                  eta: 0,
                  status: completion.duplicated ? "duplicate" : "completed",
                  error: null,
                }));
                finishUploadedAsset(
                  completion.asset!,
                  item.file,
                  Boolean(completion.duplicated),
                );
                void assignUploadedAssetToGroup(
                  completion.asset!.id,
                  completion.asset!,
                  item.groupId,
                );
              })
              .catch((error) =>
                updateQueueItem(item.id, (current) => ({
                  ...current,
                  status: "failed",
                  error: `Motivo da falha: ${error instanceof Error ? error.message : "não foi possível registrar o arquivo."}`,
                })),
              )
              .finally(resolve);
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300 && payload.asset) {
            updateQueueItem(item.id, (current) => ({
              ...current,
              loaded: item.file.size,
              speed: 0,
              eta: 0,
              status: payload.duplicated ? "duplicate" : "completed",
              error: null,
            }));
            finishUploadedAsset(
              payload.asset!,
              item.file,
              Boolean(payload.duplicated),
            );
            void assignUploadedAssetToGroup(
              payload.asset!.id,
              payload.asset!,
              item.groupId,
            );
          } else {
            const reason =
              payload.error ??
              `O servidor recusou o arquivo (HTTP ${xhr.status || "desconhecido"}).`;
            if (
              shouldRetryHttpStatus(xhr.status) &&
              item.attempts < MAX_UPLOAD_ATTEMPTS
            ) {
              void retryLater(
                item,
                `Falha temporária no upload: ${reason}`,
                item.attempts + 1,
              ).finally(resolve);
              return;
            }
            updateQueueItem(item.id, (current) => ({
              ...current,
              status: "failed",
              error: `Motivo da falha: ${reason}`,
            }));
          }
          resolve();
        };
        xhr.onerror = () => {
          requestsRef.current.delete(item.id);
          if (
            !cancelledRef.current.has(item.id) &&
            item.attempts < MAX_UPLOAD_ATTEMPTS
          ) {
            void retryLater(
              item,
              "Conexão caiu durante o upload.",
              item.attempts + 1,
            ).finally(resolve);
            return;
          }
          updateQueueItem(item.id, (current) =>
            cancelledRef.current.has(item.id)
              ? { ...current, status: "cancelled", error: null }
              : {
                  ...current,
                  status: "failed",
                  error:
                    "Motivo da falha: não foi possível concluir a conexão com o servidor durante o upload.",
                },
          );
          resolve();
        };
        xhr.onabort = () => {
          requestsRef.current.delete(item.id);
          updateQueueItem(item.id, (current) => ({
            ...current,
            status: "cancelled",
            error: null,
          }));
          resolve();
        };
        if (useDirectStorage) {
          void createSupabaseBrowserClient()
            .auth.getSession()
            .then(({ data, error }) => {
              if (error || !data.session)
                throw new Error(
                  "Sessão expirada. Entre novamente para enviar a mídia.",
                );
              xhr.setRequestHeader(
                "Authorization",
                `Bearer ${data.session.access_token}`,
              );
              xhr.setRequestHeader(
                "apikey",
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
              );
              xhr.setRequestHeader("x-upsert", "false");
              xhr.setRequestHeader("Content-Type", item.file.type);
              xhr.send(item.file);
            })
            .catch((error) => {
              if (
                isLikelyTemporaryUploadError(error) &&
                item.attempts < MAX_UPLOAD_ATTEMPTS
              ) {
                void retryLater(
                  item,
                  "Não foi possível autenticar agora.",
                  item.attempts + 1,
                ).finally(resolve);
                return;
              }
              updateQueueItem(item.id, (current) => ({
                ...current,
                status: "failed",
                error: `Motivo da falha: ${error instanceof Error ? error.message : "não foi possível autenticar o upload."}`,
              }));
              resolve();
            });
        } else {
          const body = new FormData();
          body.set("file", item.file);
          if (item.thumbnail) body.set("thumbnail", item.thumbnail);
          if (item.groupId) body.set("groupId", item.groupId);
          xhr.send(body);
        }
      };
      if (useDirectStorage && item.thumbnail) {
        void (async () => {
          const client = createSupabaseBrowserClient();
          const { data, error: sessionError } = await client.auth.getSession();
          if (sessionError || !data.session)
            throw new Error(
              "Sessão expirada. Entre novamente para enviar a mídia.",
            );
          const { error } = await client.storage
            .from(mediaBucket)
            .upload(thumbnailStoragePath!, item.thumbnail!, {
              contentType: "image/jpeg",
              upsert: false,
            });
          if (error)
            throw new Error(
              `Não foi possível armazenar a miniatura: ${error.message}`,
            );
          startUpload();
        })().catch((error) => {
          requestsRef.current.delete(item.id);
          if (
            isLikelyTemporaryUploadError(error) &&
            item.attempts < MAX_UPLOAD_ATTEMPTS
          ) {
            void retryLater(
              item,
              "Não foi possível enviar a miniatura agora.",
              item.attempts + 1,
            ).finally(resolve);
            return;
          }
          updateQueueItem(item.id, (current) => ({
            ...current,
            status: "failed",
            error: `Motivo da falha: ${error instanceof Error ? error.message : "não foi possível preparar a miniatura."}`,
          }));
          resolve();
        });
      } else startUpload();
    });
  }

  function pumpQueue() {
    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS) {
      const next = queueRef.current.find(
        (item) => item.status === "queued" && item.readyForUpload,
      );
      if (!next) return;
      const nextAttempt = next.attempts + 1;
      updateQueueItem(next.id, (current) => ({
        ...current,
        status: "uploading",
        attempts: current.attempts + 1,
        error:
          nextAttempt > 1
            ? `Retomando upload após falha de conexão (${nextAttempt}/${MAX_UPLOAD_ATTEMPTS}).`
            : null,
      }));
      activeUploadsRef.current += 1;
      void uploadFile(next).finally(() => {
        activeUploadsRef.current -= 1;
        setQueue([...queueRef.current]);
      });
    }
  }

  function prepareUploadItem(item: UploadItem) {
    return (async () => {
      try {
        updateQueueItem(item.id, (current) =>
          current.status === "preparing"
            ? {
                ...current,
                error: item.file.type.startsWith("video/")
                  ? "Preparando miniatura temporária do vídeo…"
                  : "Calculando assinatura do arquivo…",
              }
            : current,
        );
        const thumbnail = item.file.type.startsWith("video/")
          ? await createVideoFallbackThumbnail(item.file.name)
          : item.file.type === "image/gif"
            ? await createGifThumbnail(item.file)
            : undefined;
        // Devolve a thread principal antes do hash de um arquivo potencialmente grande.
        await yieldToBrowser();
        updateQueueItem(item.id, (current) =>
          current.status === "preparing"
            ? { ...current, error: "Calculando assinatura do arquivo…" }
            : current,
        );
        const checksum = await fingerprintMediaFile(item.file);
        updateQueueItem(item.id, (current) =>
          current.status === "preparing"
            ? {
                ...current,
                thumbnail,
                checksum,
                status: "queued",
                readyForUpload: true,
                error: null,
              }
            : current,
        );
      } catch (error) {
        updateQueueItem(item.id, (current) =>
          current.status === "preparing"
            ? {
                ...current,
                status: "failed",
                readyForUpload: false,
                error: `Motivo da falha: ${error instanceof Error ? error.message : "não foi possível preparar o arquivo."}`,
              }
            : current,
        );
      }
    })();
  }

  function pumpPreparationQueue() {
    while (activePreparationsRef.current < MAX_CONCURRENT_PREPARATIONS) {
      const next = queueRef.current.find(
        (item) =>
          item.status === "queued" &&
          !item.readyForUpload &&
          !preparingIdsRef.current.has(item.id),
      );
      if (!next) return;
      preparingIdsRef.current.add(next.id);
      activePreparationsRef.current += 1;
      updateQueueItem(next.id, (current) => ({
        ...current,
        status: "preparing",
      }));
      void prepareUploadItem(next).finally(() => {
        preparingIdsRef.current.delete(next.id);
        activePreparationsRef.current -= 1;
        setQueue([...queueRef.current]);
      });
    }
  }

  useEffect(() => {
    pumpPreparationQueue();
    pumpQueue();
  }, [queue]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search), 350);
    return () => window.clearTimeout(timeout);
  }, [search]);

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).map((file) =>
      normalizeGalleryFileMime(file, acceptedMimeSet),
    );
    event.target.value = "";
    if (!files.length) return;
    const acceptedFiles = files.filter(
      (file) => file.size <= maxFileSize && acceptedMimeSet.has(file.type),
    );
    const rejectedFiles = files.filter(
      (file) => file.size > maxFileSize || !acceptedMimeSet.has(file.type),
    );
    const selectedUploadGroupId = uploadGroupId || undefined;
    const queuedItems: UploadItem[] = acceptedFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      groupId: selectedUploadGroupId,
      status: "queued",
      loaded: 0,
      speed: 0,
      eta: null,
      error: null,
      attempts: 0,
      readyForUpload: false,
    }));
    const rejectedItems: UploadItem[] = rejectedFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      groupId: selectedUploadGroupId,
      status: "failed",
      loaded: 0,
      speed: 0,
      eta: null,
      error:
        file.size > maxFileSize
          ? `Motivo da falha: o arquivo excede o limite de ${formatBytes(maxFileSize)}.`
          : `Motivo da falha: formato ${file.type || file.name.split(".").at(-1) || "desconhecido"} não aceito.`,
      attempts: 0,
      readyForUpload: false,
    }));
    // Insere a fila imediatamente. A preparação pesada (miniaturas e hash) é
    // executada depois, em uma única tarefa por vez, sem bloquear a interface.
    replaceQueue((current) => [
      ...current,
      ...queuedItems,
      ...rejectedItems,
    ]);
    setUploadQueueExpanded(false);
    showMessage(
      rejectedItems.length
        ? `${queuedItems.length} arquivo(s) serão enviados e ${rejectedItems.length} rejeitado(s) permanecem visíveis na fila com o motivo.`
        : `${queuedItems.length} arquivo(s) adicionados à fila e sendo preparados em segundo plano.`,
      rejectedItems.length ? "error" : "success",
    );
  }

  async function assignUploadedAssetToGroup(
    assetId: string,
    asset?: Asset,
    groupId?: string,
  ) {
    if (!groupId || asset?.group_ids?.includes(groupId)) return;
    try {
      const response = await fetch(`${mediaApi}/groups/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds: [assetId],
          groupIds: [groupId],
          action: "add",
        }),
      });
      const payload = (await response.json()) as {
        assignments?: Assignment[];
        error?: string;
      };
      const assignments = payload.assignments;
      if (response.ok && assignments) {
        setAssignments((current) => [
          ...current.filter((item) => item.media_asset_id !== assetId),
          ...assignments,
        ]);
        if (asset)
          revealAsset(
            {
              ...asset,
              group_ids: [...new Set([...(asset.group_ids ?? []), groupId])],
            },
            false,
          );
        refreshActiveMedia();
      } else {
        showMessage(
          payload.error ??
            "A mídia foi enviada, mas não pôde ser adicionada ao grupo escolhido. Use “Organizar em grupos” para tentar novamente.",
          "error",
        );
      }
    } catch {
      showMessage(
        "A mídia foi enviada, mas não pôde ser adicionada ao grupo escolhido. Use “Organizar em grupos” para tentar novamente.",
        "error",
      );
    }
  }

  function openFilePicker() {
    inputRef.current?.click();
  }

  function retryUpload(id: string) {
    cancelledRef.current.delete(id);
    updateQueueItem(id, (item) => ({
      ...item,
      status: "queued",
      readyForUpload: Boolean(item.checksum),
      loaded: 0,
      speed: 0,
      eta: null,
      attempts: 0,
      error: null,
    }));
  }

  function cancelUpload(id: string) {
    cancelledRef.current.add(id);
    resumableRequestsRef.current.get(id)?.abort();
    const request = requestsRef.current.get(id);
    if (request) request.abort();
    else
      updateQueueItem(id, (item) => ({
        ...item,
        status: "cancelled",
        error: null,
      }));
  }

  function clearFinishedUploads() {
    replaceQueue((current) =>
      current.filter(
        (item) =>
          !["completed", "duplicate", "cancelled"].includes(item.status),
      ),
    );
  }

  const uploadStats = useMemo(() => {
    const totalBytes = queue.reduce((total, item) => total + item.file.size, 0);
    const loadedBytes = queue.reduce((total, item) => total + item.loaded, 0);
    const active = queue.filter((item) => item.status === "uploading");
    const preparing = queue.filter(
      (item) =>
        item.status === "preparing" ||
        (item.status === "queued" && !item.readyForUpload),
    ).length;
    const pending = queue.filter(
      (item) =>
        (item.status === "queued" || item.status === "retrying") &&
        item.readyForUpload,
    ).length;
    const done = queue.filter((item) =>
      ["completed", "duplicate"].includes(item.status),
    ).length;
    const failed = queue.filter((item) => item.status === "failed").length;
    const speed = active.reduce((total, item) => total + item.speed, 0);
    return {
      totalBytes,
      loadedBytes,
      active: active.length,
      preparing,
      pending,
      done,
      failed,
      speed,
      percent: totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0,
      eta: speed ? (totalBytes - loadedBytes) / speed : null,
    };
  }, [queue]);
  const visibleQueueItems = uploadQueueExpanded
    ? queue
    : queue.slice(0, QUEUE_PREVIEW_SIZE);

  const filteredAssets = useMemo(
    () =>
      assets.filter((asset) => {
        const matchesSearch =
          !debouncedSearch.trim() ||
          asset.original_name
            .toLowerCase()
            .includes(debouncedSearch.trim().toLowerCase());
        const matchesType = typeFilter === "all" || asset.kind === typeFilter;
        const matchesStatus = assetMatchesSituation(asset);
        const assetGroups = groupIdsFor(asset);
        const matchesGroup =
          groupFilter === "all" ||
          (groupFilter === "none"
            ? assetGroups.length === 0
            : assetGroups.includes(groupFilter));
        return matchesSearch && matchesType && matchesStatus && matchesGroup;
      }),
    [
      assets,
      debouncedSearch,
      typeFilter,
      statusFilter,
      groupFilter,
      assignments,
    ],
  );
  const pageState = galleryPageState({
    displayed: assets.length,
    total: totalAssets,
    hasMore: hasMoreAssets,
    nextCursor,
  });

  const filterKey = `${debouncedSearch.trim()}\u0000${typeFilter}\u0000${statusFilter}\u0000${groupFilter}`;

  function mediaUrl(cursor: string | null) {
    const params = new URLSearchParams({
      limit: "30",
      type: typeFilter,
      status: statusFilter,
    });
    if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
    if (groupFilter !== "all") params.set("group", groupFilter);
    if (cursor) params.set("cursor", cursor);
    return `${mediaApi}?${params.toString()}`;
  }

  useEffect(() => {
    if (!filtersInitializedRef.current) {
      filtersInitializedRef.current = true;
      return;
    }

    const requestId = ++filterRequestRef.current;
    const controller = new AbortController();
    const cachedPage = mediaPageCacheRef.current.get(filterKey);
    setLoadingFilter(true);
    if (cachedPage) {
      setAssets(cachedPage.assets);
      setHasMoreAssets(cachedPage.hasMore);
      setNextCursor(cachedPage.nextCursor);
      setTotalAssets(cachedPage.total);
    } else {
      setAssets([]);
      setHasMoreAssets(false);
      setNextCursor(null);
      setTotalAssets(0);
    }
    setSelectedIds([]);
    setAllFilterSelected(false);
    setFilterSelectedTotal(0);
    selectionAnchorIdRef.current = null;
    setMessage("");
    setPaginationIssue("");
    void fetch(mediaUrl(null), { cache: "no-store", signal: controller.signal })
      .then(async (response) => ({
        response,
        payload: (await response.json()) as {
          assets?: Asset[];
          hasMore?: boolean;
          nextCursor?: string | null;
          total?: number;
          error?: string;
        },
      }))
      .then(({ response, payload }) => {
        if (requestId !== filterRequestRef.current) return;
        if (!response.ok || !payload.assets)
          throw new Error(
            payload.error ??
              "Não foi possível carregar as mídias deste filtro.",
          );
        setAssets(payload.assets);
        setHasMoreAssets(Boolean(payload.hasMore));
        setNextCursor(payload.nextCursor ?? null);
        setTotalAssets(payload.total ?? payload.assets.length);
        mediaPageCacheRef.current.set(filterKey, {
          assets: payload.assets,
          hasMore: Boolean(payload.hasMore),
          nextCursor: payload.nextCursor ?? null,
          total: payload.total ?? payload.assets.length,
        });
        if (mediaPageCacheRef.current.size > 10)
          mediaPageCacheRef.current.delete(
            mediaPageCacheRef.current.keys().next().value!,
          );
        setSelectedIds([]);
        setAllFilterSelected(false);
        setFilterSelectedTotal(0);
      })
      .catch((error) => {
        if (
          requestId === filterRequestRef.current &&
          error instanceof DOMException &&
          error.name === "AbortError"
        )
          return;
        if (requestId === filterRequestRef.current)
          showMessage(
            error instanceof Error
              ? error.message
              : "Não foi possível carregar as mídias deste filtro.",
            "error",
          );
      })
      .finally(() => {
        if (requestId === filterRequestRef.current) setLoadingFilter(false);
      });
    return () => controller.abort();
    // A alteração do conjunto de filtros precisa reiniciar a paginação no servidor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, mediaRevision]);

  const selectedVisibleCount = filteredAssets.filter((asset) =>
    selectedIds.includes(asset.id),
  ).length;
  const selectionTotal = allFilterSelected
    ? filterSelectedTotal
    : selectedIds.length;
  const deletionJobPercent = activeDeletionJob?.total_count
    ? Math.round(
        (activeDeletionJob.processed_count / activeDeletionJob.total_count) *
          100,
      )
    : 0;
  const deletionJobFinished = activeDeletionJob
    ? ["completed", "completed_with_errors", "failed", "cancelled"].includes(
        activeDeletionJob.status,
      )
    : false;
  const groupAssignmentJobPercent = activeGroupAssignmentJob?.total_count
    ? Math.round(
        (activeGroupAssignmentJob.processed_count /
          activeGroupAssignmentJob.total_count) *
          100,
      )
    : 0;
  const groupAssignmentJobFinished = activeGroupAssignmentJob
    ? ["completed", "completed_with_errors", "failed", "cancelled"].includes(
        activeGroupAssignmentJob.status,
      )
    : false;

  function toggleSelected(
    assetId: string,
    event?: Pick<MouseEvent<HTMLElement>, "shiftKey">,
  ) {
    if (allFilterSelected) {
      setAllFilterSelected(false);
      setFilterSelectedTotal(0);
    }
    const anchorId = selectionAnchorIdRef.current;
    if (event?.shiftKey && anchorId) {
      const anchorIndex = filteredAssets.findIndex(
        (asset) => asset.id === anchorId,
      );
      const targetIndex = filteredAssets.findIndex(
        (asset) => asset.id === assetId,
      );
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = filteredAssets
          .slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          )
          .map((asset) => asset.id);
        setSelectedIds((current) => [...new Set([...current, ...range])]);
        return;
      }
    }
    selectionAnchorIdRef.current = assetId;
    setSelectedIds((current) =>
      current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId],
    );
  }

  function toggleAllVisible() {
    const visibleIds = filteredAssets.map((asset) => asset.id);
    setAllFilterSelected(false);
    setFilterSelectedTotal(0);
    setSelectedIds((current) =>
      selectedVisibleCount === visibleIds.length
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }

  function currentFilterPayload() {
    return {
      search: debouncedSearch.trim(),
      type: typeFilter,
      status: statusFilter,
      group: groupFilter,
    };
  }

  function clearFilterSelection() {
    setAllFilterSelected(false);
    setFilterSelectedTotal(0);
    setSelectedIds([]);
    selectionAnchorIdRef.current = null;
  }

  function applyQueuedDeletionVisualState(queuedIds?: string[]) {
    const queuedIdSet = new Set(queuedIds ?? []);
    setAssets((current) =>
      allFilterSelected
        ? current.filter((asset) => !assetMatchesActiveFilters(asset))
        : queuedIdSet.size
          ? current.filter((asset) => !queuedIdSet.has(asset.id))
          : current,
    );
    setAssignments((current) =>
      queuedIdSet.size
        ? current.filter(
            (assignment) => !queuedIdSet.has(assignment.media_asset_id),
          )
        : current,
    );
    clearFilterSelection();
    refreshActiveMedia();
  }

  async function selectAllMatchingFilter() {
    if (selectingFilter || loadingFilter || loadingMore || totalAssets <= 0)
      return;
    setSelectingFilter(true);
    setMessage("");
    try {
      const response = await fetch(`${mediaApi}/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectAllMatching: true,
          dryRun: true,
          filters: currentFilterPayload(),
        }),
      });
      const payload = (await response.json()) as {
        total?: number;
        error?: string;
      };
      if (!response.ok || typeof payload.total !== "number") {
        showMessage(
          payload.error ??
            "Não foi possível selecionar todas as mídias deste filtro.",
          "error",
        );
        return;
      }
      setAllFilterSelected(true);
      setFilterSelectedTotal(payload.total);
      setSelectedIds(filteredAssets.map((asset) => asset.id));
      showMessage(
        `${payload.total} mídia(s) deste filtro foram selecionadas.`,
        "neutral",
      );
    } catch {
      showMessage(
        "Não foi possível conectar ao servidor para selecionar este filtro.",
        "error",
      );
    } finally {
      setSelectingFilter(false);
    }
  }

  async function loadMoreAssets() {
    if (loadingMore || loadingFilter || pageState.remaining <= 0) return;
    if (!nextCursor) {
      const issue =
        "A paginação perdeu o cursor. Recarregando a galeria automaticamente para recuperar as próximas mídias.";
      setPaginationIssue(issue);
      showMessage(issue, "error");
      refreshActiveMedia();
      return;
    }
    setLoadingMore(true);
    setPaginationIssue("");
    try {
      const response = await fetch(mediaUrl(nextCursor), { cache: "no-store" });
      const payload = (await response.json()) as {
        assets?: Asset[];
        hasMore?: boolean;
        nextCursor?: string | null;
        total?: number;
        error?: string;
      };
      if (!response.ok || !payload.assets) {
        const issue =
          payload.error ??
          "Não foi possível carregar mais mídias. A galeria vai tentar se recuperar na próxima atualização.";
        setPaginationIssue(issue);
        showMessage(issue, "error");
        return;
      }
      const currentIds = new Set(assets.map((asset) => asset.id));
      const nextItems = payload.assets.filter(
        (asset) => !currentIds.has(asset.id),
      );
      const added = nextItems.length;
      setAssets((current) => {
        const knownIds = new Set(current.map((asset) => asset.id));
        return [
          ...current,
          ...nextItems.filter((asset) => !knownIds.has(asset.id)),
        ];
      });
      if (!added && payload.assets.length) {
        const issue =
          "A próxima página voltou repetida. Recarregando a galeria automaticamente para corrigir a paginação.";
        setPaginationIssue(issue);
        showMessage(issue, "error");
        refreshActiveMedia();
        return;
      }
      setHasMoreAssets(Boolean(payload.hasMore));
      setNextCursor(payload.nextCursor ?? null);
      setTotalAssets(payload.total ?? totalAssets);
      const nextTotal = payload.total ?? totalAssets;
      const displayedAfterAppend = assets.length + added;
      if (displayedAfterAppend < nextTotal && !payload.nextCursor) {
        const issue =
          "Ainda existem mídias para carregar, mas o servidor não enviou o próximo cursor. Recarregando a galeria automaticamente.";
        setPaginationIssue(issue);
        showMessage(issue, "error");
        refreshActiveMedia();
      }
      mediaPageCacheRef.current.delete(filterKey);
    } catch {
      const issue =
        "Não foi possível conectar ao servidor para carregar mais mídias.";
      setPaginationIssue(issue);
      showMessage(issue, "error");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const sentinel = gallerySentinelRef.current;
    if (!sentinel || loadingFilter || loadingMore || !pageState.canLoadMore)
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void loadMoreAssets();
      },
      { root: null, rootMargin: "700px 0px 700px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // A paginação automática depende do cursor atual e da quantidade já carregada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterKey,
    mediaRevision,
    assets.length,
    totalAssets,
    nextCursor,
    loadingFilter,
    loadingMore,
    pageState.canLoadMore,
  ]);

  useEffect(() => {
    if (!activeDeletionJob || deletionJobFinished) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void fetch(`${mediaApi}/delete-jobs/${activeDeletionJob.id}`, {
        cache: "no-store",
      })
        .then(async (response) => ({
          response,
          payload: (await response.json()) as {
            job?: MediaDeletionJob;
            error?: string;
          },
        }))
        .then(({ response, payload }) => {
          if (cancelled) return;
          if (!response.ok || !payload.job)
            throw new Error(
              payload.error ?? "Não foi possível atualizar a fila de exclusão.",
            );
          setActiveDeletionJob(payload.job);
          if (
            ["completed", "completed_with_errors"].includes(payload.job.status)
          ) {
            refreshActiveMedia();
            showMessage(
              payload.job.status === "completed"
                ? `${payload.job.deleted_count} mídia(s) foram apagadas em segundo plano.`
                : `${payload.job.deleted_count} mídia(s) apagadas; ${payload.job.failed_count} falharam. Motivo: ${deletionJobReviewMessage(payload.job) ?? "abra os detalhes da fila para revisar."}`,
              payload.job.failed_count ? "error" : "success",
            );
          }
        })
        .catch((error) => {
          if (!cancelled)
            showMessage(
              error instanceof Error
                ? error.message
                : "Não foi possível atualizar a fila de exclusão.",
              "error",
            );
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeDeletionJob, deletionJobFinished]);

  useEffect(() => {
    if (!activeGroupAssignmentJob || groupAssignmentJobFinished) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void fetch(
        `${mediaApi}/group-assignment-jobs/${activeGroupAssignmentJob.id}`,
        { cache: "no-store" },
      )
        .then(async (response) => ({
          response,
          payload: (await response.json()) as {
            job?: MediaGroupAssignmentJob;
            error?: string;
          },
        }))
        .then(({ response, payload }) => {
          if (cancelled) return;
          if (!response.ok || !payload.job)
            throw new Error(
              payload.error ??
                "Não foi possível atualizar a fila de organização em grupos.",
            );
          setActiveGroupAssignmentJob(payload.job);
          if (
            ["completed", "completed_with_errors"].includes(payload.job.status)
          ) {
            refreshActiveMedia();
            showMessage(
              payload.job.status === "completed"
                ? `${payload.job.applied_count} mídia(s) foram organizadas em grupos em segundo plano.`
                : `${payload.job.applied_count} mídia(s) organizadas; ${payload.job.failed_count} falharam e ${payload.job.skipped_count} foram ignoradas.`,
              payload.job.failed_count ? "error" : "success",
            );
          }
        })
        .catch((error) => {
          if (!cancelled)
            showMessage(
              error instanceof Error
                ? error.message
                : "Não foi possível atualizar a fila de organização em grupos.",
              "error",
            );
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeGroupAssignmentJob, groupAssignmentJobFinished]);

  async function applyBulkGroups() {
    if (!selectedIds.length || !bulkGroupIds.length) return;
    setBulkSaving(true);
    setMessage("");
    try {
      const response = await fetch(`${mediaApi}/groups/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds: selectedIds,
          groupIds: bulkGroupIds,
          action: bulkAction,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        assignments?: Assignment[];
        affected?: number;
        queued?: boolean;
        job?: { id: string; totalCount: number } | null;
      };
      if (response.status === 202 && payload.queued && payload.job) {
        setActiveGroupAssignmentJob({
          id: payload.job.id,
          action: bulkAction,
          status: "pending",
          total_count: payload.job.totalCount,
          processed_count: 0,
          applied_count: 0,
          skipped_count: 0,
          failed_count: 0,
          last_error_message: null,
        });
        refreshActiveMedia();
        showMessage(
          `${payload.job.totalCount} mídia(s) foram enviadas para organização em grupos em segundo plano. A fila vai processar em blocos.`,
          "success",
        );
        setBulkOpen(false);
        setBulkGroupIds([]);
        clearFilterSelection();
        return;
      }
      if (!response.ok || !payload.assignments) {
        showMessage(
          payload.error ?? "Não foi possível atualizar os grupos.",
          "error",
        );
        return;
      }
      const updatedAssignments = [
        ...assignments.filter(
          (assignment) => !selectedIds.includes(assignment.media_asset_id),
        ),
        ...payload.assignments,
      ];
      const visibleBefore = assets.filter(
        (asset) =>
          selectedIds.includes(asset.id) &&
          assetMatchesActiveFilters(asset, assignments),
      ).length;
      const visibleAfter = assets.filter(
        (asset) =>
          selectedIds.includes(asset.id) &&
          assetMatchesActiveFilters(asset, updatedAssignments),
      ).length;
      setAssignments(updatedAssignments);
      setAssets((current) =>
        current.filter((asset) =>
          assetMatchesActiveFilters(asset, updatedAssignments),
        ),
      );
      setTotalAssets((current) =>
        Math.max(0, current + visibleAfter - visibleBefore),
      );
      refreshActiveMedia();
      showMessage(
        `${payload.affected ?? selectedIds.length} mídia(s) atualizada(s).`,
        "success",
      );
      setBulkOpen(false);
      setBulkGroupIds([]);
    } catch {
      showMessage("Não foi possível conectar ao servidor.", "error");
    } finally {
      setBulkSaving(false);
    }
  }

  async function deleteAsset(asset: Asset) {
    if (!window.confirm(`Excluir “${asset.original_name}”?`)) return;
    const response = await fetch(`${mediaApi}/${asset.id}`, {
      method: "DELETE",
    });
    const payload = (await response.json()) as DeleteMediaPayload;
    if (!response.ok && response.status !== 207) {
      showMessage(
        payload.error ?? "Não foi possível excluir a mídia.",
        "error",
      );
      return;
    }
    const deletedIds = payload.deletedIds?.length
      ? payload.deletedIds
      : [asset.id];
    const deletedIdSet = new Set(deletedIds);
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    setAssignments((current) =>
      current.filter(
        (assignment) => !deletedIdSet.has(assignment.media_asset_id),
      ),
    );
    setSelectedIds((current) => current.filter((id) => !deletedIdSet.has(id)));
    refreshActiveMedia();
    setTotalAssets((current) => Math.max(0, current - deletedIds.length));
    showMessage(
      deleteMessage(
        deletedIds.length,
        payload.affectedItemIds?.length ?? 0,
        payload.warning ?? payload.error,
      ),
      payload.error ? "error" : "success",
    );
  }

  async function deleteSelectedAssets() {
    if ((!selectedIds.length && !allFilterSelected) || deletingSelected) return;

    const selectedAssets = assets.filter((asset) =>
      selectedIds.includes(asset.id),
    );
    const total = allFilterSelected
      ? filterSelectedTotal
      : selectedAssets.length;
    if (!total) return;

    const noun = allFilterSelected
      ? total === 1
        ? "1 mídia deste filtro"
        : `${total} mídias deste filtro`
      : total === 1
        ? "mídia selecionada"
        : `${total} mídias selecionadas`;
    const asyncNotice =
      total > 100
        ? isTwitter
          ? " Como são mais de 100 mídias, a exclusão será validada e processada em lote pelo servidor X."
          : " Como são mais de 100 mídias, a exclusão será enfileirada e processada em segundo plano."
        : "";
    if (
      !window.confirm(
        `Excluir permanentemente ${noun}? Esta ação remove os arquivos da galeria e não pode ser desfeita.${asyncNotice}`,
      )
    )
      return;

    setDeletingSelected(true);
    setMessage("");

    try {
      const response = await fetch(`${mediaApi}/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          allFilterSelected
            ? { selectAllMatching: true, filters: currentFilterPayload() }
            : { assetIds: selectedAssets.map((asset) => asset.id) },
        ),
      });
      const payload = (await response.json()) as DeleteMediaPayload;
      const deletedIds = payload.deletedIds ?? [];

      if (!response.ok && response.status !== 207) {
        showMessage(
          payload.error ?? "Não foi possível excluir as mídias selecionadas.",
          "error",
        );
        return;
      }

      if (payload.queued && payload.job) {
        setActiveDeletionJob({
          id: payload.job.id,
          status: "pending",
          total_count: payload.job.totalCount,
          processed_count: 0,
          deleted_count: 0,
          affected_item_count: 0,
          failed_count: 0,
          last_error_message: null,
        });
        applyQueuedDeletionVisualState(payload.queuedAssetIds);
        setTotalAssets((current) =>
          Math.max(0, current - payload.job!.totalCount),
        );
        showMessage(
          `${payload.job.totalCount} mídia(s) foram enviadas para exclusão em segundo plano. A fila vai processar em blocos.`,
          "success",
        );
        return;
      }

      if (deletedIds.length) {
        const deletedIdSet = new Set(deletedIds);
        setAssets((current) =>
          current.filter((asset) => !deletedIdSet.has(asset.id)),
        );
        setAssignments((current) =>
          current.filter(
            (assignment) => !deletedIdSet.has(assignment.media_asset_id),
          ),
        );
        setSelectedIds((current) =>
          current.filter((id) => !deletedIdSet.has(id)),
        );
        if (allFilterSelected) clearFilterSelection();
        refreshActiveMedia();
        setTotalAssets((current) => Math.max(0, current - deletedIds.length));
      }

      showMessage(
        deleteMessage(
          deletedIds.length,
          payload.affectedItemIds?.length ?? 0,
          payload.warning ?? payload.error,
        ),
        payload.error ? "error" : "success",
      );
    } catch {
      showMessage(
        "Não foi possível conectar ao servidor para excluir as mídias.",
        "error",
      );
    } finally {
      setDeletingSelected(false);
    }
  }

  async function repairThumbnail(asset: Asset) {
    if (asset.kind !== "video") return;
    try {
      await recoverThumbnailForAsset(asset);
      refreshActiveMedia();
      showMessage(
        `Miniatura recuperada para “${asset.original_name}”.`,
        "success",
      );
    } catch (error) {
      showMessage(
        error instanceof Error
          ? `Não foi possível gerar a miniatura de “${asset.original_name}”: ${error.message}`
          : `Não foi possível gerar a miniatura de “${asset.original_name}”.`,
        "error",
      );
    }
  }

  async function fetchVideoForThumbnail(asset: Asset) {
    let signedUrl = asset.signed_url;
    if (!signedUrl) {
      // A primeira página carregada pelo Server Component antigo não fornecia a
      // URL original quando já existia placeholder. Busca uma URL nova antes de
      // desistir, sem obrigar o operador a atualizar a página.
      const response = await fetch(`${mediaApi}/${asset.id}/thumbnail`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        video_url?: string | null;
        error?: string;
      };
      if (!response.ok || !payload.video_url)
        throw new Error(
          payload.error ?? "A URL temporária do vídeo não está disponível.",
        );
      signedUrl = payload.video_url;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      THUMBNAIL_RECOVERY_DOWNLOAD_TIMEOUT_MS,
    );
    try {
      const response = await fetch(signedUrl, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          `Não foi possível baixar o vídeo para extrair a miniatura (HTTP ${response.status}).`,
        );
      const blob = await response.blob();
      if (!blob.size) throw new Error("O arquivo de vídeo está vazio.");
      return new File([blob], asset.original_name, {
        type: asset.mime_type || blob.type || "video/mp4",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw new Error("O download do vídeo excedeu 90 segundos.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function recoverThumbnailForAsset(asset: Asset) {
    if (asset.kind !== "video") return;
    try {
      console.info("[gallery] Iniciando recuperação de miniatura.", {
        assetId: asset.id,
        name: asset.original_name,
        mimeType: asset.mime_type,
      });
      const file = await fetchVideoForThumbnail(asset);
      const thumbnail = await createRealVideoThumbnail(file);
      await uploadRealThumbnail(asset.id, thumbnail, true);
      console.info("[gallery] Miniatura recuperada.", {
        assetId: asset.id,
        name: asset.original_name,
      });
      return true;
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "Não foi possível gerar a miniatura deste vídeo.",
      );
    }
  }

  function loadThumbnailImage(blob: Blob) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      const timeout = window.setTimeout(
        () => finish(new Error("A miniatura não respondeu em 15 segundos.")),
        15_000,
      );
      const finish = (error?: Error) => {
        window.clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        URL.revokeObjectURL(url);
        if (error) reject(error);
        else resolve(image);
      };
      image.onload = () => finish();
      image.onerror = () =>
        finish(new Error("O arquivo da miniatura está inválido."));
      image.src = url;
    });
  }

  async function needsThumbnailRecovery(asset: Asset) {
    // Vídeos antigos receberam uma imagem fallback com o texto “Vídeo”. Ela
    // ocupa thumbnail_url normalmente, portanto verificar somente null nunca
    // encontraria os cartões exibidos como placeholder na galeria.
    if (!asset.thumbnail_url) return true;
    try {
      const response = await fetch(asset.thumbnail_url, { cache: "no-store" });
      if (!response.ok) return true;
      const image = await loadThumbnailImage(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(image, 0, 0, 1, 1);
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
      // createVideoFallbackThumbnail gera exatamente 640×360 com o fundo
      // #111827. A tolerância cobre a compressão JPEG sem confundir um frame.
      return (
        image.naturalWidth === 640 &&
        image.naturalHeight === 360 &&
        Math.abs(red - 17) <= 10 &&
        Math.abs(green - 24) <= 10 &&
        Math.abs(blue - 39) <= 10
      );
    } catch (error) {
      console.warn(
        "[gallery] Miniatura existente indisponível; ela será recuperada.",
        { assetId: asset.id, name: asset.original_name, error },
      );
      return true;
    }
  }

  async function recoverMissingThumbnails() {
    if (
      thumbnailRecovery?.phase === "scanning" ||
      thumbnailRecovery?.phase === "recovering" ||
      loadingFilter
    )
      return;
    const filterUrl = (cursor: string | null) => {
      const params = new URLSearchParams({
        limit: "30",
        type: typeFilter,
        status: statusFilter,
      });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (groupFilter !== "all") params.set("group", groupFilter);
      if (cursor) params.set("cursor", cursor);
      return `${mediaApi}?${params.toString()}`;
    };
    const recovery: ThumbnailRecovery = {
      phase: "scanning",
      scanned: 0,
      discovered: 0,
      processed: 0,
      recovered: 0,
      failures: [],
    };
    setThumbnailRecovery(recovery);
    setMessage("");
    try {
      let cursor: string | null = null;
      let hasMore = true;
      while (hasMore) {
        const response = await fetch(filterUrl(cursor), { cache: "no-store" });
        const payload = (await response.json()) as {
          assets?: Asset[];
          hasMore?: boolean;
          nextCursor?: string | null;
          error?: string;
        };
        if (!response.ok || !payload.assets)
          throw new Error(
            payload.error ??
              "Não foi possível localizar os vídeos deste filtro.",
          );
        const videos = payload.assets.filter((asset) => asset.kind === "video");
        const pending: Asset[] = [];
        for (const asset of videos) {
          if (await needsThumbnailRecovery(asset)) {
            pending.push(asset);
            recovery.discovered += 1;
          }
          recovery.scanned += 1;
          setThumbnailRecovery({
            ...recovery,
            failures: [...recovery.failures],
          });
          await yieldToBrowser();
        }
        console.info("[gallery] Página da recuperação analisada.", {
          videos: videos.length,
          pending: pending.length,
          cursor,
        });
        recovery.phase = "recovering";
        setThumbnailRecovery({ ...recovery, failures: [...recovery.failures] });
        for (const asset of pending) {
          try {
            await recoverThumbnailForAsset(asset);
            recovery.recovered += 1;
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Não foi possível gerar a miniatura.";
            recovery.failures.push({ name: asset.original_name, message });
            console.warn("[gallery] Falha ao recuperar miniatura.", {
              assetId: asset.id,
              name: asset.original_name,
              message,
            });
          } finally {
            recovery.processed += 1;
            setThumbnailRecovery({
              ...recovery,
              failures: [...recovery.failures],
            });
            await yieldToBrowser();
          }
        }
        hasMore = Boolean(payload.hasMore);
        cursor = payload.nextCursor ?? null;
        if (hasMore && !cursor)
          throw new Error(
            "A paginação não retornou o cursor necessário para concluir a recuperação.",
          );
      }
      refreshActiveMedia();
      console.info("[gallery] Recuperação de miniaturas concluída.", {
        scanned: recovery.scanned,
        discovered: recovery.discovered,
        recovered: recovery.recovered,
        failures: recovery.failures.length,
      });
      showMessage(
        recovery.discovered
          ? `${recovery.recovered} de ${recovery.discovered} miniatura(s) ausente(s) foram recuperadas${recovery.failures.length ? `; ${recovery.failures.length} falharam, mas os demais vídeos continuaram.` : "."}`
          : "Não há vídeos sem miniatura no filtro atual.",
        recovery.failures.length ? "error" : "success",
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Não foi possível iniciar a recuperação das miniaturas.";
      recovery.failures.push({ name: "Busca da galeria", message });
      showMessage(message, "error");
    } finally {
      recovery.phase = "completed";
      setThumbnailRecovery({ ...recovery, failures: [...recovery.failures] });
    }
  }

  function renderAsset(asset: Asset) {
    const assetGroups = groupIdsFor(asset);
    const isStaticPreview = asset.kind === "image" || asset.kind === "gif";
    const previewUrl =
      asset.kind === "gif"
        ? (asset.thumbnail_url ?? asset.signed_url)
        : isStaticPreview
          ? asset.signed_url
          : asset.thumbnail_url;
    const kindLabel =
      asset.kind === "image"
        ? "Imagem"
        : asset.kind === "gif"
          ? "GIF"
          : "Vídeo";
    return (
      <article
        className={`panel media-card ${view === "list" ? "media-card-list" : ""} ${selectedIds.includes(asset.id) ? "media-card-selected" : ""}`}
        key={asset.id}
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "button, input, video, select, a",
            )
          )
            return;
          toggleSelected(asset.id, event);
        }}
      >
        <label
          className="media-select"
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selectedIds.includes(asset.id)}
            onClick={(event) => toggleSelected(asset.id, event)}
            onChange={() => undefined}
            aria-label={`Selecionar ${asset.original_name}`}
          />
        </label>
        {previewUrl ? (
          <div className="media-thumbnail">
            {isStaticPreview ? (
              <img
                loading="lazy"
                decoding="async"
                src={previewUrl}
                alt={asset.original_name}
              />
            ) : (
              <>
                <img
                  loading="lazy"
                  decoding="async"
                  src={previewUrl}
                  alt={`Miniatura de ${asset.original_name}`}
                />
                <span aria-hidden="true">▶</span>
              </>
            )}
          </div>
        ) : (
          <div
            className="media-thumbnail media-thumbnail-fallback"
            aria-label={
              asset.kind === "video"
                ? "Vídeo sem miniatura"
                : "Imagem indisponível"
            }
          >
            {asset.kind === "video" ? "▶" : "▣"}
          </div>
        )}
        <div className="media-card-body">
          <div className="media-card-heading">
            <h2 title={asset.original_name}>{asset.original_name}</h2>
            <span className="media-kind">{kindLabel}</span>
          </div>
          <p className="media-meta">
            {formatBytes(asset.size_bytes)} · {asset.status}
          </p>
          <div className="media-card-state">
            {asset.publication_state?.scheduled_count ? (
              <span className="media-state-badge">
                {asset.first_published_at ? "Agendada novamente" : "Agendada"}
                {asset.publication_state.scheduled_count > 1
                  ? ` · ${asset.publication_state.scheduled_count}`
                  : ""}
              </span>
            ) : null}
            {asset.first_published_at && (
              <span className="media-state-badge media-state-published">
                Publicada
              </span>
            )}
          </div>
          <div className="media-card-tags">
            {assetGroups.length ? (
              assetGroups
                .slice(0, 2)
                .map((id) => (
                  <span key={id}>
                    {groups.find((group) => group.id === id)?.name ?? "Grupo"}
                  </span>
                ))
            ) : (
              <span className="tag-muted">Sem grupo</span>
            )}
            {assetGroups.length > 2 && (
              <span className="tag-muted">+{assetGroups.length - 2}</span>
            )}
          </div>
          {asset.processing_error && (
            <p className="profile-error">{asset.processing_error}</p>
          )}
          {canManage && (
            <button
              className="button button-danger"
              type="button"
              onClick={() => deleteAsset(asset)}
            >
              Excluir
            </button>
          )}
        </div>
      </article>
    );
  }

  const groupedSections = groups
    .map((group) => ({
      group,
      items: filteredAssets.filter((asset) =>
        groupIdsFor(asset).includes(group.id),
      ),
    }))
    .filter((section) => section.items.length);
  const ungrouped = filteredAssets.filter(
    (asset) => groupIdsFor(asset).length === 0,
  );

  return (
    <main className="standalone-page gallery-page">
      <header className="standalone-header">
        <div>
          <span className="section-kicker">
            {activeOrganization.name} ·{" "}
            {isTwitter ? "X / Twitter" : "Biblioteca"}
          </span>
          <h1>Galeria de mídia</h1>
          <p>
            Biblioteca completa da organização. Use o filtro de situação para
            separar não postadas, agendadas, publicadas e estados do arquivo.
          </p>
        </div>
        {!isTwitter ? (
          <div className="gallery-upload-control">
            <label>
              Adicionar diretamente ao grupo
              <select
                value={uploadGroupId}
                onChange={(event) => setUploadGroupId(event.target.value)}
                disabled={!canManage}
              >
                <option value="">Sem grupo</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button button-primary"
              type="button"
              onClick={openFilePicker}
              disabled={!canManage}
            >
              ＋ Adicionar mídia
            </button>
          </div>
        ) : null}
      </header>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        multiple
        accept={acceptedMimeTypes}
        onChange={addFiles}
      />

      {queue.length > 0 && (
        <section
          className="panel upload-progress upload-queue"
          role="status"
          aria-live="polite"
        >
          <div className="upload-queue-heading">
            <div>
              <strong>Fila de uploads</strong>
              <p>
                {uploadStats.active} enviando · {uploadStats.preparing}{" "}
                preparando · {uploadStats.pending} aguardando ·{" "}
                {uploadStats.done} concluídos
                {uploadStats.failed ? ` · ${uploadStats.failed} com falha` : ""}
              </p>
            </div>
            <div className="upload-queue-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={openFilePicker}
                disabled={!canManage}
              >
                ＋ Adicionar mais
              </button>
              <button
                className="button button-ghost"
                type="button"
                onClick={clearFinishedUploads}
              >
                Limpar concluídos
              </button>
            </div>
          </div>
          <div className="upload-summary">
            <strong>{uploadStats.percent}%</strong>
            <span>
              {formatBytes(uploadStats.loadedBytes)} de{" "}
              {formatBytes(uploadStats.totalBytes)}
            </span>
            <span>
              Velocidade:{" "}
              {formatSpeed(uploadStats.speed, uploadStats.active > 0)}
            </span>
            <span>
              Previsão: {formatEta(uploadStats.eta, uploadStats.active > 0)}
            </span>
          </div>
          <progress max="100" value={uploadStats.percent}>
            {uploadStats.percent}%
          </progress>
          <div className="upload-items">
            {visibleQueueItems.map((item) => {
              const itemPercent = item.file.size
                ? Math.round((item.loaded / item.file.size) * 100)
                : 0;
              return (
                <article
                  className={`upload-item upload-item-${item.status}`}
                  key={item.id}
                >
                  <span className="upload-item-icon" aria-hidden="true">
                    {item.file.type.startsWith("video/") ? "▶" : "▧"}
                  </span>
                  <div className="upload-item-info">
                    <strong title={item.file.name}>{item.file.name}</strong>
                    <div className="upload-item-status">
                      <b>{statusLabel(item.status)}</b>
                      <span>
                        {formatBytes(item.loaded)} de{" "}
                        {formatBytes(item.file.size)}
                        {item.status === "uploading"
                          ? ` · ${formatSpeed(item.speed)}`
                          : ""}
                      </span>
                    </div>
                    {item.error && (
                      <p className="upload-item-error">
                        <b>Motivo da falha:</b>{" "}
                        {item.error.replace(/^Motivo da falha:\s*/i, "")}
                      </p>
                    )}
                    <progress max="100" value={itemPercent}>
                      {itemPercent}%
                    </progress>
                  </div>
                  <div className="upload-item-actions">
                    {item.status === "failed" && (
                      <button
                        className="button button-ghost"
                        type="button"
                        onClick={() => retryUpload(item.id)}
                      >
                        Tentar novamente
                      </button>
                    )}
                    {["queued", "uploading"].includes(item.status) && (
                      <button
                        type="button"
                        className="danger-action"
                        onClick={() => cancelUpload(item.id)}
                      >
                        Cancelar
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {queue.length > QUEUE_PREVIEW_SIZE && (
            <button
              className="upload-queue-toggle"
              type="button"
              onClick={() => setUploadQueueExpanded((current) => !current)}
            >
              {uploadQueueExpanded
                ? "Mostrar menos arquivos"
                : `Ver todos os ${queue.length} arquivos da fila`}
            </button>
          )}
        </section>
      )}

      {message && (
        <p
          className={`inline-message inline-message-${messageTone}`}
          role={messageTone === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      )}
      {activeDeletionJob && (
        <section
          className="panel gallery-deletion-job"
          role="status"
          aria-live="polite"
        >
          <div>
            <span className="section-kicker">Exclusão em segundo plano</span>
            <h2>
              {deletionJobFinished
                ? "Fila de exclusão finalizada"
                : "Apagando mídias em segundo plano"}
            </h2>
            <p>
              {activeDeletionJob.processed_count} de{" "}
              {activeDeletionJob.total_count} processadas ·{" "}
              {activeDeletionJob.deleted_count} apagadas
              {activeDeletionJob.affected_item_count
                ? ` · ${activeDeletionJob.affected_item_count} publicação(ões) marcadas como “Mídia apagada”`
                : ""}
              {activeDeletionJob.failed_count
                ? ` · ${activeDeletionJob.failed_count} falha(s)`
                : ""}
            </p>
            {deletionJobReviewMessage(activeDeletionJob) && (
              <p className="gallery-job-error">
                <b>Motivo principal:</b>{" "}
                {deletionJobReviewMessage(activeDeletionJob)}
              </p>
            )}
            {Boolean(activeDeletionJob.failure_details?.length) && (
              <details
                className="gallery-job-details"
                open={deletionJobFinished}
              >
                <summary>
                  Ver mídias que falharam ({activeDeletionJob.failed_count})
                </summary>
                <ul>
                  {activeDeletionJob.failure_details!.map((detail) => (
                    <li key={`${detail.mediaAssetId}-${detail.message}`}>
                      <strong>
                        {detail.originalName ?? detail.mediaAssetId}
                      </strong>
                      <span>{detail.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {Boolean(activeDeletionJob.warning_details?.length) && (
              <details className="gallery-job-details">
                <summary>
                  Avisos de fallback do Storage (
                  {activeDeletionJob.warning_details!.length})
                </summary>
                <ul>
                  {activeDeletionJob.warning_details!.map((detail) => (
                    <li key={`${detail.mediaAssetId}-${detail.message}`}>
                      <strong>
                        {detail.originalName ?? detail.mediaAssetId}
                      </strong>
                      <span>{detail.message}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="gallery-deletion-progress">
            <strong>{deletionJobPercent}%</strong>
            <progress max="100" value={deletionJobPercent}>
              {deletionJobPercent}%
            </progress>
          </div>
          {deletionJobFinished && (
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setActiveDeletionJob(null)}
            >
              Ocultar
            </button>
          )}
        </section>
      )}
      {activeGroupAssignmentJob && (
        <section
          className="panel gallery-deletion-job"
          role="status"
          aria-live="polite"
        >
          <div>
            <span className="section-kicker">
              Organização em grupos em segundo plano
            </span>
            <h2>
              {groupAssignmentJobFinished
                ? "Fila de grupos finalizada"
                : "Organizando mídias em segundo plano"}
            </h2>
            <p>
              {activeGroupAssignmentJob.processed_count} de{" "}
              {activeGroupAssignmentJob.total_count} processadas ·{" "}
              {activeGroupAssignmentJob.applied_count} aplicadas
              {activeGroupAssignmentJob.skipped_count
                ? ` · ${activeGroupAssignmentJob.skipped_count} ignorada(s)`
                : ""}
              {activeGroupAssignmentJob.failed_count
                ? ` · ${activeGroupAssignmentJob.failed_count} falha(s)`
                : ""}
            </p>
            {activeGroupAssignmentJob.last_error_message && (
              <p className="profile-error">
                {activeGroupAssignmentJob.last_error_message}
              </p>
            )}
          </div>
          <div className="gallery-deletion-progress">
            <strong>{groupAssignmentJobPercent}%</strong>
            <progress max="100" value={groupAssignmentJobPercent}>
              {groupAssignmentJobPercent}%
            </progress>
          </div>
          {groupAssignmentJobFinished && (
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setActiveGroupAssignmentJob(null)}
            >
              Ocultar
            </button>
          )}
        </section>
      )}
      <section className="panel gallery-toolbar">
        {isTwitter && canManage ? (
          <div className="gallery-twitter-upload-row">
            <div>
              <strong>Biblioteca do X</strong>
              <span>
                Envie uma vez e vincule a mídia aos mesmos grupos usados pelos perfis.
              </span>
            </div>
            <label>
              Grupo de perfis
              <select
                value={uploadGroupId}
                onChange={(event) => setUploadGroupId(event.target.value)}
              >
                <option value="">Sem grupo</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button button-primary gallery-add-media"
              type="button"
              onClick={openFilePicker}
            >
              <span aria-hidden="true">＋</span> Adicionar mídia
            </button>
          </div>
        ) : null}
        <div className="gallery-filters">
          <input
            aria-label="Buscar mídia"
            placeholder="Buscar por nome…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filtrar por tipo"
            value={typeFilter}
            onChange={(event) =>
              setTypeFilter(event.target.value as typeof typeFilter)
            }
          >
            <option value="all">Todos os tipos</option>
            <option value="image">Imagens</option>
            {isTwitter ? <option value="gif">GIFs</option> : null}
            <option value="video">Vídeos</option>
          </select>
          <select
            aria-label="Filtrar por situação"
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as GallerySituationFilter)
            }
          >
            <option value="all">Todas as situações</option>
            <option value="schedulable">Disponíveis para agendar</option>
            <option value="unposted">Não postadas</option>
            <option value="scheduled">Agendadas / em fila</option>
            <option value="posted">Postadas</option>
            <option value="posted_scheduled">
              Postadas e agendadas novamente
            </option>
            <option value="uploaded">Arquivo enviado</option>
            <option value="ready">Arquivo pronto</option>
            <option value="processing">Arquivo processando</option>
            <option value="failed">Arquivo com erro</option>
          </select>
          <select
            aria-label="Filtrar por grupo"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
          >
            <option value="all">Todos os grupos</option>
            <option value="none">Sem grupo</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>
        <div className="gallery-toolbar-actions">
          <button
            className="button button-ghost"
            type="button"
            onClick={toggleAllVisible}
            disabled={deletingSelected}
          >
            {selectedVisibleCount === filteredAssets.length &&
            filteredAssets.length
              ? "Desmarcar visíveis"
              : "Selecionar visíveis"}
          </button>
          {canManage && (
            <button
              className="button gallery-select-filter"
              type="button"
              onClick={() =>
                allFilterSelected
                  ? clearFilterSelection()
                  : void selectAllMatchingFilter()
              }
              disabled={
                deletingSelected ||
                selectingFilter ||
                loadingFilter ||
                totalAssets <= 0
              }
            >
              {allFilterSelected
                ? "Desmarcar filtro"
                : selectingFilter
                  ? "Selecionando filtro…"
                  : "Selecionar todas as mídias deste filtro"}
            </button>
          )}
          <span
            className={`selection-count ${allFilterSelected ? "selection-count-filter" : ""}`}
          >
            {allFilterSelected
              ? `${selectionTotal} do filtro`
              : `${selectionTotal} selecionada(s)`}
          </span>
          {canManage && (
            <button
              className="button button-primary"
              type="button"
              disabled={
                !selectedIds.length || allFilterSelected || deletingSelected
              }
              onClick={() => {
                setBulkAction("add");
                setBulkGroupIds([]);
                setBulkOpen(true);
              }}
            >
              Organizar selecionadas
            </button>
          )}
          {canManage && selectionTotal > 0 && (
            <button
              className="button gallery-delete-selected"
              type="button"
              disabled={deletingSelected}
              onClick={() => void deleteSelectedAssets()}
            >
              {deletingSelected ? (
                "Excluindo…"
              ) : (
                <>
                  <span aria-hidden="true">⌫</span> Excluir selecionadas
                </>
              )}
            </button>
          )}
          <div className="view-switcher" aria-label="Modo de visualização">
            <button
              type="button"
              className={view === "grid" ? "active" : ""}
              onClick={() => setView("grid")}
            >
              Grade
            </button>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              onClick={() => setView("list")}
            >
              Lista
            </button>
            <button
              type="button"
              className={view === "groups" ? "active" : ""}
              onClick={() => setView("groups")}
            >
              Por grupos
            </button>
          </div>
        </div>
        <div className="gallery-thumbnail-recovery-action">
          <div>
            <strong>Miniaturas de vídeo</strong>
            <span>
              Localiza previews ausentes, quebradas e placeholders neste filtro.
            </span>
          </div>
          {canManage && (
            <button
              className="button gallery-recover-thumbnails"
              type="button"
              onClick={() => void recoverMissingThumbnails()}
              disabled={
                loadingFilter ||
                thumbnailRecovery?.phase === "scanning" ||
                thumbnailRecovery?.phase === "recovering"
              }
            >
              {thumbnailRecovery?.phase === "scanning"
                ? `Analisando ${thumbnailRecovery.scanned} vídeo(s)…`
                : thumbnailRecovery?.phase === "recovering"
                  ? `Gerando ${thumbnailRecovery.processed}/${thumbnailRecovery.discovered}…`
                  : "Recuperar miniaturas ausentes"}
            </button>
          )}
        </div>
        {thumbnailRecovery && (
          <section
            className="gallery-thumbnail-recovery-status"
            role="status"
            aria-live="polite"
          >
            <div>
              <strong>
                {thumbnailRecovery.phase === "scanning"
                  ? "Analisando miniaturas do filtro"
                  : thumbnailRecovery.phase === "recovering"
                    ? "Gerando miniaturas pendentes"
                    : "Recuperação de miniaturas finalizada"}
              </strong>
              <p>
                {thumbnailRecovery.phase === "scanning"
                  ? `${thumbnailRecovery.scanned} vídeo(s) verificados · ${thumbnailRecovery.discovered} precisam de recuperação`
                  : `${thumbnailRecovery.processed} de ${thumbnailRecovery.discovered} processados · ${thumbnailRecovery.recovered} recuperados${thumbnailRecovery.failures.length ? ` · ${thumbnailRecovery.failures.length} falha(s)` : ""}`}
              </p>
              {thumbnailRecovery.failures.length > 0 && (
                <details
                  className="gallery-job-details"
                  open={thumbnailRecovery.phase === "completed"}
                >
                  <summary>
                    Ver falhas ({thumbnailRecovery.failures.length})
                  </summary>
                  <ul>
                    {thumbnailRecovery.failures.map((failure, index) => (
                      <li key={`${failure.name}-${index}`}>
                        <strong>{failure.name}</strong>
                        <span>{failure.message}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="gallery-thumbnail-recovery-progress">
              <progress
                max="100"
                value={
                  thumbnailRecovery.phase === "scanning"
                    ? undefined
                    : thumbnailRecovery.discovered
                      ? Math.round(
                          (thumbnailRecovery.processed /
                            thumbnailRecovery.discovered) *
                            100,
                        )
                      : 0
                }
              >
                {thumbnailRecovery.processed}
              </progress>
              {thumbnailRecovery.phase === "completed" && (
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => setThumbnailRecovery(null)}
                >
                  Fechar
                </button>
              )}
            </div>
          </section>
        )}
        {allFilterSelected && (
          <p className="gallery-filter-selection-note">
            A seleção inclui todas as {selectionTotal} mídia(s) que batem com os
            filtros atuais, não apenas as visíveis na tela.
          </p>
        )}
      </section>

      {loadingFilter ? (
        <section className="panel empty-state" role="status" aria-live="polite">
          <span className="empty-state-icon" aria-hidden="true">
            ◌
          </span>
          <h2>Carregando mídias…</h2>
          <p>Atualizando a galeria para o filtro selecionado.</p>
        </section>
      ) : assets.length === 0 ? (
        <section className="panel empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            ◈
          </span>
          <h2>Nenhuma mídia na galeria</h2>
          <p>Envie imagens ou vídeos para começar a montar suas publicações.</p>
        </section>
      ) : filteredAssets.length === 0 ? (
        <section className="panel empty-state">
          <h2>Nenhuma mídia neste filtro</h2>
          <p>Ajuste a situação, a busca, o tipo ou selecione outro grupo.</p>
        </section>
      ) : view === "groups" ? (
        <section className="gallery-group-sections">
          {groupedSections.map(({ group, items }) => (
            <section key={group.id} className="gallery-group-section">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">Grupo</span>
                  <h2>{group.name}</h2>
                </div>
                <span className="group-count">{items.length} mídia(s)</span>
              </div>
              <div className="media-grid">{items.map(renderAsset)}</div>
            </section>
          ))}
          {ungrouped.length > 0 && (
            <section className="gallery-group-section">
              <div className="panel-heading">
                <div>
                  <span className="section-kicker">Organização</span>
                  <h2>Sem grupo</h2>
                </div>
                <span className="group-count">{ungrouped.length} mídia(s)</span>
              </div>
              <div className="media-grid">{ungrouped.map(renderAsset)}</div>
            </section>
          )}
        </section>
      ) : (
        <section
          className={`media-grid ${view === "list" ? "media-list" : ""}`}
          aria-label="Galeria de mídia"
        >
          {filteredAssets.map(renderAsset)}
        </section>
      )}
      <div
        ref={gallerySentinelRef}
        className="gallery-pagination-sentinel"
        aria-hidden="true"
      />
      {loadingMore && (
        <p className="gallery-result-count" role="status">
          Carregando mais mídias automaticamente…
        </p>
      )}
      {!loadingFilter &&
        !loadingMore &&
        pageState.remaining > 0 &&
        !nextCursor && (
          <p
            className="gallery-result-count gallery-pagination-error"
            role="alert"
          >
            A paginação está sem cursor para carregar as {pageState.remaining}{" "}
            mídia(s) restantes. A galeria está tentando se recuperar
            automaticamente.
          </p>
        )}
      {!loadingFilter && paginationIssue && (
        <p
          className="gallery-result-count gallery-pagination-error"
          role="alert"
        >
          {paginationIssue}
        </p>
      )}
      {!loadingFilter && pageState.reachedEnd && (
        <p className="gallery-result-count" role="status">
          Não há mais mídias para exibir.
        </p>
      )}

      {bulkOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="panel bulk-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-group-title"
          >
            <div className="panel-heading">
              <div>
                <span className="section-kicker">
                  {selectedIds.length} mídia(s) selecionada(s)
                </span>
                <h2 id="bulk-group-title">Organizar em grupos</h2>
              </div>
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setBulkOpen(false)}
              >
                Fechar
              </button>
            </div>
            <p className="bulk-modal-help">
              Escolha a ação e o grupo de destino. Para transferir, selecione
              “Mover para outro grupo”.
            </p>
            <label className="bulk-operation-field">
              O que deseja fazer?
              <select
                value={bulkAction}
                onChange={(event) => {
                  setBulkAction(event.target.value as typeof bulkAction);
                  setBulkGroupIds([]);
                }}
              >
                <option value="add">
                  Adicionar a grupo(s), mantendo os atuais
                </option>
                <option value="replace">Mover para outro grupo</option>
                <option value="remove">Remover de grupo(s)</option>
              </select>
            </label>
            <fieldset className="bulk-group-list">
              <legend>
                {bulkAction === "replace"
                  ? "Grupo de destino"
                  : bulkAction === "remove"
                    ? "Grupo(s) dos quais remover"
                    : "Grupo(s) a adicionar"}
              </legend>
              {groups.length ? (
                groups.map((group) => (
                  <label key={group.id}>
                    <input
                      type={bulkAction === "replace" ? "radio" : "checkbox"}
                      name={
                        bulkAction === "replace"
                          ? "destination-group"
                          : undefined
                      }
                      checked={bulkGroupIds.includes(group.id)}
                      onChange={() =>
                        setBulkGroupIds((current) =>
                          bulkAction === "replace"
                            ? [group.id]
                            : current.includes(group.id)
                              ? current.filter((id) => id !== group.id)
                              : [...current, group.id],
                        )
                      }
                    />
                    <span>{group.name}</span>
                  </label>
                ))
              ) : (
                <p className="muted-text">
                  Crie um grupo antes de organizar as mídias.
                </p>
              )}
            </fieldset>
            {bulkAction === "replace" && (
              <p className="profile-error">
                As mídias selecionadas serão removidas dos grupos atuais e
                ficarão apenas no grupo de destino escolhido.
              </p>
            )}
            <div className="detail-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setBulkOpen(false)}
              >
                Cancelar
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={bulkSaving || !bulkGroupIds.length}
                onClick={applyBulkGroups}
              >
                {bulkSaving
                  ? "Salvando…"
                  : bulkAction === "replace"
                    ? "Mover mídias"
                    : bulkAction === "remove"
                      ? "Remover dos grupos"
                      : "Adicionar aos grupos"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
