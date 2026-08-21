import { randomUUID } from 'node:crypto';

import {
  processInstagramPublication,
  type PublicationFormat,
  type PublicationWorkItem,
} from '@/lib/integrations/instagram-publisher';
import { processZernioInstagramPublication } from '@/lib/integrations/zernio-publisher';
import { PUBLICATION_MAX_ATTEMPTS } from '@/lib/publications/attempts';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type ClaimedItem = {
  id: string;
  organization_id: string;
  profile_id: string;
  execute_at: string | null;
  format: PublicationFormat;
  caption: string | null;
  creation_id: string | null;
  reel_cover_media_asset_id: string | null;
};

type MediaRow = {
  position: number;
  media_assets: {
    id: string;
    storage_path: string;
    kind: 'image' | 'video';
    status: string;
    deleted_at: string | null;
    organization_id: string;
  } | {
    id: string;
    storage_path: string;
    kind: 'image' | 'video';
    status: string;
    deleted_at: string | null;
    organization_id: string;
  }[] | null;
};

function invalidWorkItem(message: string) {
  return { state: 'failed' as const, retryable: false, errorCode: 'invalid_work_item', errorMessage: message };
}

function removedWorkItem(message = 'Mídia apagada.') {
  return { state: 'removed' as const, retryable: false, errorCode: 'media_deleted', errorMessage: message };
}

type InvalidLoadedWorkItem = ReturnType<typeof invalidWorkItem> | ReturnType<typeof removedWorkItem>;

function errorInfo(error: unknown) {
  if (error instanceof Error) {
    return {
      code: (error as Error & { code?: string }).code,
      message: error.message,
      stack: error.stack,
    };
  }

  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    return {
      code: typeof value.code === 'string' ? value.code : undefined,
      message: typeof value.message === 'string' ? value.message : undefined,
      details: typeof value.details === 'string' ? value.details : undefined,
      hint: typeof value.hint === 'string' ? value.hint : undefined,
    };
  }

  return { message: String(error) };
}

async function loadWorkItem(item: ClaimedItem): Promise<PublicationWorkItem | InvalidLoadedWorkItem> {
  const supabase = createSupabaseAdminClient();
  const [profileResult, mediaResult, coverResult] = await Promise.all([
    supabase
      .from('instagram_profiles')
      .select('id, organization_id, provider, instagram_user_id, encrypted_access_token, zernio_account_id, zernio_connection_id')
      .eq('id', item.profile_id)
      .eq('organization_id', item.organization_id)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase
      .from('publication_item_media')
      .select('position, media_assets!inner(id, storage_path, kind, status, deleted_at, organization_id)')
      .eq('publication_item_id', item.id)
      .eq('organization_id', item.organization_id)
      .order('position'),
    item.reel_cover_media_asset_id
      ? supabase
        .from('media_assets')
        .select('id, storage_path, kind, status, deleted_at, organization_id')
        .eq('id', item.reel_cover_media_asset_id)
        .eq('organization_id', item.organization_id)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (profileResult.error || !profileResult.data) return invalidWorkItem('O perfil do Instagram não está mais disponível.');
  if (mediaResult.error) return invalidWorkItem('Não foi possível carregar as mídias do item.');
  if (coverResult.error) return invalidWorkItem('Não foi possível carregar a capa do Reel.');

  const mediaRows = (mediaResult.data ?? []) as MediaRow[];
  const hasDeletedMedia = mediaRows.some((row) => {
    const asset = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
    return Boolean(asset && asset.organization_id === item.organization_id && (asset.deleted_at || asset.status === 'deleted'));
  });
  if (hasDeletedMedia) return removedWorkItem();

  const media = mediaRows.flatMap((row) => {
    const asset = Array.isArray(row.media_assets) ? row.media_assets[0] : row.media_assets;
    if (!asset || asset.organization_id !== item.organization_id) return [];
    if (asset.status !== 'ready') return [];
    if (asset.kind !== 'image' && asset.kind !== 'video') return [];
    return [{ id: asset.id, storage_path: asset.storage_path, kind: asset.kind }];
  });

  if (media.length !== mediaRows.length) return invalidWorkItem('Uma ou mais mídias não estão prontas para publicação.');
  const coverAsset = coverResult.data;
  if (item.reel_cover_media_asset_id && (!coverAsset || coverAsset.organization_id !== item.organization_id)) return removedWorkItem('A capa personalizada foi apagada.');
  if (coverAsset && (coverAsset.deleted_at || coverAsset.status === 'deleted')) return removedWorkItem('A capa personalizada foi apagada.');
  if (coverAsset && (coverAsset.status !== 'ready' || coverAsset.kind !== 'image')) return invalidWorkItem('A capa personalizada não está pronta para publicação.');

  return {
    id: item.id,
    execute_at: item.execute_at,
    format: item.format,
    caption: item.caption,
    creation_id: item.creation_id,
    profile: profileResult.data,
    media,
    cover: coverAsset ? { id: coverAsset.id, storage_path: coverAsset.storage_path, kind: 'image' } : null,
  };
}

export type DispatchOptions = {
  workerId?: string;
  limit?: number;
  leaseSeconds?: number;
};

type MissedScheduleRecovery = {
  id: string;
  outcome: 'rescheduled_once' | 'requires_attention';
};

async function recoverMissedPublicationSchedules() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('recover_missed_publication_slots', {
    p_max_items: 100,
    p_grace_seconds: 120,
  });
  if (error) throw error;

  const recovered = (data ?? []) as MissedScheduleRecovery[];
  return {
    scanned: recovered.length,
    rescheduled: recovered.filter((item) => item.outcome === 'rescheduled_once').length,
    requiresAttention: recovered.filter((item) => item.outcome === 'requires_attention').length,
  };
}

async function recoverUnexpectedDispatcherFailure(itemId: string, workerId: string, error: unknown) {
  const supabase = createSupabaseAdminClient();
  const original = errorInfo(error);
  const message = [original.message, original.details, original.hint].filter(Boolean).join(' — ').slice(0, 1200)
    || 'Falha inesperada ao processar o item.';
  const { error: completionError } = await supabase.rpc('complete_publication_item', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_outcome: 'failed',
    p_error_code: original.code || 'dispatcher_unexpected_error',
    p_error_message: message,
    p_retryable: false,
  });

  if (completionError) {
    const fallbackUpdate = await supabase
      .from('publication_items')
      .update({
        status: 'failed',
        claimed_by: null,
        lease_until: null,
        next_attempt_at: null,
        last_error_code: original.code || 'dispatcher_unexpected_error',
        last_error_message: message,
      })
      .eq('id', itemId)
      .eq('claimed_by', workerId);

    console.error('Não foi possível concluir pelo RPC; fallback direto do item executado.', {
      itemId,
      original,
      completionError: errorInfo(completionError),
      fallbackUpdateError: fallbackUpdate.error ? errorInfo(fallbackUpdate.error) : undefined,
    });
  }

  return message;
}

async function preserveConfirmedPublication(itemId: string, workerId: string, metaMediaId: string | null) {
  const supabase = createSupabaseAdminClient();
  const update = {
    status: 'published',
    ...(metaMediaId ? { meta_media_id: metaMediaId } : {}),
    published_at: new Date().toISOString(),
    claimed_by: null,
    lease_until: null,
    next_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
  };
  const { data: item, error: itemError } = await supabase
    .from('publication_items')
    .update(update)
    .eq('id', itemId)
    .eq('claimed_by', workerId)
    .select('organization_id')
    .maybeSingle();

  if (itemError || !item) throw itemError ?? new Error('O item não pôde ser preservado após confirmação da Meta.');

  // Este caminho só ocorre se o RPC principal não pôde persistir um sucesso já
  // confirmado pela Meta. Mantemos o mesmo pós-processamento essencial para
  // não deixar reserva diária pendurada nem perder a primeira publicação.
  const [{ error: reservationError }, { error: mediaError }, { error: batchError }] = await Promise.all([
    supabase.from('publication_profile_daily_reservations').delete().eq('publication_item_id', itemId),
    supabase.rpc('mark_publication_item_media_as_published', { p_item_id: itemId, p_organization_id: item.organization_id }),
    supabase.rpc('sync_publication_batch_status_for_item', { p_item_id: itemId }),
  ]);
  if (reservationError) throw reservationError;
  if (mediaError || batchError) console.error('Fallback preservou publicação, mas não executou pós-processamento completo.', {
    itemId,
    workerId,
    mediaError: mediaError ? errorInfo(mediaError) : undefined,
    batchError: batchError ? errorInfo(batchError) : undefined,
  });
}

async function reserveDailyPublicationLimit(itemId: string, workerId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('reserve_publication_daily_limit', {
    p_item_id: itemId,
    p_worker_id: workerId,
    p_limit: 100,
    p_reservation_seconds: 300,
  });
  if (error) throw error;

  const result = (data as Array<{ allowed: boolean; published_count: number; next_attempt_at: string | null }> | null)?.[0];
  if (!result) throw new Error('A reserva do limite diário não retornou resultado.');
  if (!result.allowed) {
    console.info('Publicação adiada pelo limite diário do perfil.', {
      itemId,
      publishedCount: result.published_count,
      nextAttemptAt: result.next_attempt_at,
    });
  }
  return result.allowed;
}

async function processClaimedItem(item: ClaimedItem, workerId: string) {
  const supabase = createSupabaseAdminClient();
  try {
    const workItem = await loadWorkItem(item);
    const result = 'state' in workItem
      ? workItem
      : workItem.profile.provider === 'zernio'
        ? await processZernioInstagramPublication(workItem)
        : await processInstagramPublication(workItem, () => reserveDailyPublicationLimit(item.id, workerId));

    if (result.state === 'processing') {
      const { error } = await supabase.rpc('defer_publication_item', {
        p_item_id: item.id,
        p_worker_id: workerId,
        p_creation_id: result.creationId,
        p_delay_seconds: 60,
        p_is_poll: Boolean(item.creation_id),
      });
      if (error) throw error;
      return { itemId: item.id, state: 'processing' };
    }

    // O RPC de limite diário já devolveu o item para waiting; não devemos
    // sobrescrever esse estado nem liberar outra tentativa nesta execução.
    if (result.state === 'deferred') return { itemId: item.id, state: result.reason };

    const { error } = await supabase.rpc('complete_publication_item', {
      p_item_id: item.id,
      p_worker_id: workerId,
      p_outcome: result.state === 'published' ? 'published' : result.state === 'removed' ? 'removed' : 'failed',
      p_meta_media_id: result.state === 'published' ? result.metaMediaId : null,
      p_error_code: result.state === 'failed' || result.state === 'removed' ? result.errorCode : null,
      p_error_message: result.state === 'failed' || result.state === 'removed' ? result.errorMessage : null,
      p_retryable: result.state === 'failed' && result.retryable,
      p_max_attempts: PUBLICATION_MAX_ATTEMPTS,
    });
    if (error) {
      // A Meta já confirmou a criação. Se a persistência principal falhar,
      // o fallback preserva o sucesso e evita que esse creation_id seja enviado
      // novamente em uma retomada posterior.
      if (result.state === 'published') {
        await preserveConfirmedPublication(item.id, workerId, result.metaMediaId);
      } else {
        throw error;
      }
    }

    return { itemId: item.id, state: result.state, recovered: result.state === 'published' && result.recovered === true };
  } catch (error) {
    const message = await recoverUnexpectedDispatcherFailure(item.id, workerId, error);
    console.error('Falha isolada no dispatcher de publicação.', {
      itemId: item.id,
      error: errorInfo(error),
      message,
    });
    return { itemId: item.id, state: 'error', error: message };
  }
}

export async function dispatchPublicationQueue(options: DispatchOptions = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `dispatch-${randomUUID()}`;
  // Claim e execução usam o mesmo teto para não reservar itens que esta
  // invocação não conseguirá iniciar antes do fim da função serverless.
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit!, 1), 5) : 5;
  const leaseSeconds = Number.isInteger(options.leaseSeconds)
    ? Math.min(Math.max(options.leaseSeconds!, 30), 900)
    : 180;
  const supabase = createSupabaseAdminClient();

  // Um item que perdeu o horário não pode ser publicado atrasado. Antes de
  // qualquer claim, a rotina transacional o move uma única vez para a próxima
  // data livre na mesma faixa diária; uma segunda perda exige ação humana.
  const recovery = await recoverMissedPublicationSchedules();

  const { data: claimed, error: claimError } = await supabase.rpc('claim_publication_items', {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (claimError) throw claimError;

  const items = claimed as ClaimedItem[] ?? [];
  // O claim e a concorrência têm o mesmo teto. Cada tarefa possui seu próprio
  // try/catch, logo uma falha não cancela nem bloqueia as demais.
  const settled = await Promise.allSettled(items.map((item) => processClaimedItem(item, workerId)));
  const processed = settled.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { itemId: items[index].id, state: 'error', error: errorInfo(entry.reason).message ?? 'Falha desconhecida no processamento paralelo.' });

  console.info('Dispatcher de publicação concluído.', {
    workerId,
    recovery,
    claimed: items.length,
    states: processed.reduce<Record<string, number>>((counts, item) => {
      counts[item.state] = (counts[item.state] ?? 0) + 1;
      return counts;
    }, {}),
  });
  return { workerId, recovery, claimed: items.length, processed };
}
