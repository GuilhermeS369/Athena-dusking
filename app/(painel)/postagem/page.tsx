import { redirect } from 'next/navigation';

import { bulkPublishingEnabled } from '@/lib/publications/bulk-feature';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import PublishingClient from '@/app/postagem/publishing-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows, POSTGREST_MAX_ROWS } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signMediaPreviewUrl } from '@/lib/storage/media-storage';
import {
  ComposerFormat,
  emptyScheduledCountsByFormat,
  emptyPublicationFormatCounts,
  ProfilePublicationMetrics,
  PublicationFormatCounts,
  ScheduledCountsByFormat,
} from '@/lib/publications/composer';

export const dynamic = 'force-dynamic';

type ComposerSummaryRow = {
  profile_id: string;
  scheduled_post_count: number | null;
  scheduled_counts: unknown;
  published_counts: unknown;
  scheduled_by_time: unknown;
  scheduled_by_format_and_time: unknown;
};

const composerFormats: ComposerFormat[] = ['reel', 'story', 'image', 'carousel'];

function formatCountsFromJson(value: unknown): PublicationFormatCounts {
  const counts = emptyPublicationFormatCounts();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  const record = value as Record<string, unknown>;
  for (const format of composerFormats) {
    const count = Number(record[format] ?? 0);
    counts[format] = Number.isFinite(count) ? count : 0;
  }
  const total = Number(record.total ?? composerFormats.reduce((sum, format) => sum + counts[format], 0));
  counts.total = Number.isFinite(total) ? total : 0;
  return counts;
}

function timeCountsFromJson(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const counts: Record<string, number> = {};
  for (const [time, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(raw ?? 0);
    if (Number.isFinite(count)) counts[time] = count;
  }
  return counts;
}

/**
 * Normaliza garantindo as quatro chaves de formato. A RPC já devolve todas, mas
 * o compositor lê `scheduled_by_format_and_time[formato][horário]` sem checar o
 * nível do meio: um formato ausente aqui viraria TypeError no seletor.
 */
function formatTimeCountsFromJson(value: unknown): ScheduledCountsByFormat {
  const counts = emptyScheduledCountsByFormat();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  const record = value as Record<string, unknown>;
  for (const format of composerFormats) {
    counts[format] = timeCountsFromJson(record[format]);
  }
  return counts;
}

export default function PublishingPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton variant="form" />}>
      <PublishingPageContent />
    </Suspense>
  );
}

async function PublishingPageContent() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const organizationId = context.activeOrganization.id;
  const supabase = await createSupabaseServerClient();
  // Nunca carregue publication_items linha a linha ao abrir o compositor.
  // Em organizações grandes, isso traz todo o histórico publicado, bloqueia o
  // SSR e deixa a tela em carregamento permanente. A agregação é feita pelo
  // banco e devolve somente uma linha de métricas por perfil.
  const [profilesResult, assetsResult, groupsResult, composerSummariesResult] = await Promise.all([
    // Organizations can hold more online profiles than PostgREST's default row cap (1000),
    // which would otherwise silently truncate the composer's profile list and counts.
    fetchAllRows((from, to) => supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, status, provider, zernio_account_id, zernio_connection_id')
      .eq('organization_id', organizationId)
      .eq('status', 'online')
      .is('deleted_at', null)
      // username não é único no banco; o desempate por id fecha a ordem total.
      .order('username', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    supabase
      .from('media_assets')
      .select('id, original_name, mime_type, kind, size_bytes, status, storage_path, thumbnail_storage_path, created_at')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(18),
    supabase
      .from('profile_groups')
      .select('id, name, description, consumption_mode, default_caption, profile_group_members(profile_id)')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    // Mesma armadilha do teto de linhas do PostgREST logo acima, e ela mordeu
    // aqui: com 1.150 perfis online a RPC devolvia exatamente 1.000 linhas e os
    // 150 restantes ficavam sem métrica nenhuma, aparecendo como "0/0" no
    // seletor mesmo tendo dezenas de publicações agendadas. A função agrega por
    // profile_id mas não impõe ordem no resultado, e sem ordem determinística
    // paginar traria linhas repetidas e outras faltando. O order explícito
    // abaixo é o que torna a paginação correta.
    //
    // O tamanho de página é o teto do servidor, não o padrão de 1.000, e isso é
    // deliberado: o PostgREST aplica o `.range()` DEPOIS de a função ter
    // calculado o conjunto inteiro, então cada página a mais é uma agregação
    // inteira a mais sobre as ~350 mil linhas elegíveis de publication_items.
    // Medido em 02/09/2026 com 1.401 perfis: 4,8 s em duas páginas de 1.000
    // contra 2,4 s numa página só. `fetchAllRows` continua no laço, então uma
    // organização acima do teto ainda é lida por inteiro — só volta a pagar
    // duas passagens, como pagava sempre.
    fetchAllRows<ComposerSummaryRow>((from, to) => supabase
      .rpc('get_posting_composer_profile_summaries', {
        p_organization_id: organizationId,
        p_slot_horizon_days: 90,
      })
      .order('profile_id', { ascending: true })
      .range(from, to), POSTGREST_MAX_ROWS),
  ]);

  const assetIds = (assetsResult.data ?? []).map((asset) => asset.id);
  const [assignmentsResult, mediaPublicationStatesResult] = assetIds.length
    ? await Promise.all([
      supabase
        .from('media_group_assignments')
        .select('media_asset_id, group_id')
        .eq('organization_id', organizationId)
        .in('media_asset_id', assetIds),
      supabase.rpc('get_media_publication_states', {
        p_organization_id: organizationId,
        p_media_asset_ids: assetIds,
      }),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const loadErrors = {
    profiles: profilesResult.error?.message,
    assets: assetsResult.error?.message,
    groups: groupsResult.error?.message,
    assignments: assignmentsResult.error?.message,
    composerSummaries: composerSummariesResult.error?.message,
    mediaPublicationStates: mediaPublicationStatesResult.error?.message,
  };
  if (Object.values(loadErrors).some(Boolean)) {
    // A página precisa continuar disponível para não transformar uma falha de
    // leitura, schema ainda não migrado ou instabilidade transitória em erro 500.
    // O detalhe fica nos logs da Vercel para diagnóstico objetivo.
    console.error('Falha parcial ao carregar /postagem', loadErrors);
  }

  const mediaPublicationStates = new Map<string, { scheduled_count: number; next_scheduled_at: string | null; has_published: boolean }>();
  for (const row of mediaPublicationStatesResult.data ?? []) {
    mediaPublicationStates.set(row.media_asset_id, {
      scheduled_count: row.scheduled_count,
      next_scheduled_at: row.next_scheduled_at,
      has_published: row.has_published,
    });
  }
  const composerSummaries = composerSummariesResult.data ?? [];
  const summaryByProfileId = new Map<string, {
    scheduled_post_count: number;
    metrics: ProfilePublicationMetrics;
    scheduled_by_time: Record<string, number>;
    scheduled_by_format_and_time: ScheduledCountsByFormat;
  }>();
  for (const row of composerSummaries) {
    summaryByProfileId.set(row.profile_id, {
      scheduled_post_count: row.scheduled_post_count ?? 0,
      metrics: {
        scheduled: formatCountsFromJson(row.scheduled_counts),
        published: formatCountsFromJson(row.published_counts),
      },
      scheduled_by_time: timeCountsFromJson(row.scheduled_by_time),
      scheduled_by_format_and_time: formatTimeCountsFromJson(row.scheduled_by_format_and_time),
    });
  }
  console.info('Métricas agregadas de /postagem carregadas', {
    organizationId,
    onlineProfiles: profilesResult.data?.length ?? 0,
    metricRows: composerSummaries.length,
    profilesWithReels: [...summaryByProfileId.values()].filter((summary) => summary.metrics.scheduled.reel + summary.metrics.published.reel > 0).length,
    profilesWithStories: [...summaryByProfileId.values()].filter((summary) => summary.metrics.scheduled.story + summary.metrics.published.story > 0).length,
  });

  const assets = await Promise.all((assetsResult.data ?? []).map(async (asset) => {
    const [signed, thumbnail] = await Promise.all([
      signMediaPreviewUrl(supabase, asset.storage_path, 60 * 30, asset.kind === 'image' ? { width: 320, height: 320, resize: 'contain', quality: 65, format: 'origin' } : undefined),
      asset.thumbnail_storage_path ? signMediaPreviewUrl(supabase, asset.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
    ]);

    return {
      ...asset,
      signed_url: signed.data?.signedUrl ?? null,
      thumbnail_url: thumbnail.data?.signedUrl ?? null,
      publication_state: mediaPublicationStates.get(asset.id) ?? null,
    };
  }));

  return (
    <PublishingClient
      activeOrganization={context.activeOrganization}
      bulkPublishingEnabled={bulkPublishingEnabled(context.activeOrganization.role)}
      // Os horários ocupados de cada perfil NÃO vão aqui. Eram 89% destas props
      // (13,8 MiB para 1.401 perfis, 367.744 timestamps) e só são lidos depois
      // de escolher um destino — o cliente os busca em /api/publications/composer/slots
      // para os perfis daquele destino.
      profiles={(profilesResult.data ?? []).map((profile) => {
        const summary = summaryByProfileId.get(profile.id);
        return {
          ...profile,
          publication_metrics: summary?.metrics,
          // A agenda ocupada melhora a prévia recorrente, mas não pode derrubar
          // a página quando a migration/coluna da fila ainda não está disponível.
          scheduled_post_count: summary?.scheduled_post_count ?? 0,
          scheduled_by_time: summary?.scheduled_by_time ?? {},
          scheduled_by_format_and_time: summary?.scheduled_by_format_and_time ?? emptyScheduledCountsByFormat(),
        };
      })}
      assets={assets}
      batches={[]}
      groups={groupsResult.data ?? []}
      assignments={assignmentsResult.data ?? []}
    />
  );
}
