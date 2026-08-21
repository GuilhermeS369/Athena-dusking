import { redirect } from 'next/navigation';

import { bulkPublishingEnabled } from '@/lib/publications/bulk-feature';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import PublishingClient from '@/app/postagem/publishing-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  ComposerFormat,
  emptyScheduledCountsByFormat,
  emptyScheduledSlotsByFormat,
  emptyPublicationFormatCounts,
  postingTimeWindow,
  ProfilePublicationMetrics,
  PublicationFormatCounts,
  ScheduledCountsByFormat,
  ScheduledSlotsByFormat,
} from '@/lib/publications/composer';
import type { ComposerMetricRow } from '@/lib/publications/composer-metrics-fallback';

export const dynamic = 'force-dynamic';

type ComposerMetricsRow = Omit<ComposerMetricRow, 'scheduled_post_count'> & { scheduled_post_count: number | null };

const composerFormats: ComposerFormat[] = ['reel', 'story', 'image', 'carousel'];

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

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

function scheduledSlotsFromJson(value: unknown): ScheduledSlotsByFormat {
  const slots = emptyScheduledSlotsByFormat();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return slots;
  const record = value as Record<string, unknown>;
  for (const format of composerFormats) {
    slots[format] = stringArray(record[format]);
  }
  return slots;
}

function scheduledCountsByTime(slots: ScheduledSlotsByFormat): ScheduledCountsByFormat {
  const counts = emptyScheduledCountsByFormat();
  for (const format of composerFormats) {
    for (const executeAt of slots[format]) {
      const time = postingTimeWindow(executeAt);
      if (time) counts[format][time] = (counts[format][time] ?? 0) + 1;
    }
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

  const supabase = await createSupabaseServerClient();
  // Nunca carregue publication_items linha a linha ao abrir o compositor.
  // Em organizações grandes, isso traz todo o histórico publicado, bloqueia o
  // SSR e deixa a tela em carregamento permanente. A agregação é feita pelo
  // banco e devolve somente uma linha de métricas por perfil.
  const [profilesResult, assetsResult, groupsResult, composerMetricsResult] = await Promise.all([
    supabase
      .from('instagram_profiles_safe')
      .select('id, username, display_name, profile_picture_url, status, provider, zernio_account_id, zernio_connection_id')
      .eq('organization_id', context.activeOrganization.id)
      .eq('status', 'online')
      .is('deleted_at', null)
      .order('username', { ascending: true }),
    supabase
      .from('media_assets')
      .select('id, original_name, mime_type, kind, size_bytes, status, storage_path, thumbnail_storage_path, created_at')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(18),
    supabase
      .from('profile_groups')
      .select('id, name, description, consumption_mode, default_caption, profile_group_members(profile_id)')
      .eq('organization_id', context.activeOrganization.id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    supabase.rpc('get_posting_composer_profile_metrics', {
      p_organization_id: context.activeOrganization.id,
      p_slot_horizon_days: 90,
    }),
  ]);

  const assetIds = (assetsResult.data ?? []).map((asset) => asset.id);
  const [assignmentsResult, mediaPublicationStatesResult] = assetIds.length
    ? await Promise.all([
      supabase
        .from('media_group_assignments')
        .select('media_asset_id, group_id')
        .eq('organization_id', context.activeOrganization.id)
        .in('media_asset_id', assetIds),
      supabase.rpc('get_media_publication_states', {
        p_organization_id: context.activeOrganization.id,
        p_media_asset_ids: assetIds,
      }),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];

  const loadErrors = {
    profiles: profilesResult.error?.message,
    assets: assetsResult.error?.message,
    groups: groupsResult.error?.message,
    assignments: assignmentsResult.error?.message,
    composerMetrics: composerMetricsResult.error?.message,
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
  const composerMetrics = (composerMetricsResult.data ?? []) as ComposerMetricsRow[];
  console.info('Métricas agregadas de /postagem carregadas', {
    organizationId: context.activeOrganization.id,
    onlineProfiles: profilesResult.data?.length ?? 0,
    metricRows: composerMetrics.length,
    profilesWithReels: composerMetrics.filter((metric) => metric.scheduled_counts.reel + metric.published_counts.reel > 0).length,
    profilesWithStories: composerMetrics.filter((metric) => metric.scheduled_counts.story + metric.published_counts.story > 0).length,
  });
  const composerMetricsByProfileId = new Map<string, ComposerMetricsRow>();
  for (const row of composerMetrics) {
    composerMetricsByProfileId.set(row.profile_id, row);
  }

  const assets = await Promise.all((assetsResult.data ?? []).map(async (asset) => {
    const [signed, thumbnail] = await Promise.all([
      supabase.storage.from('instagram-media').createSignedUrl(asset.storage_path, 60 * 30, asset.kind === 'image' ? { transform: { width: 320, height: 320, resize: 'contain', quality: 65, format: 'origin' } } : undefined),
      asset.thumbnail_storage_path ? supabase.storage.from('instagram-media').createSignedUrl(asset.thumbnail_storage_path, 60 * 10) : Promise.resolve({ data: null }),
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
      profiles={(profilesResult.data ?? []).map((profile) => ({
        ...profile,
        publication_metrics: composerMetricsByProfileId.has(profile.id) ? {
          scheduled: formatCountsFromJson(composerMetricsByProfileId.get(profile.id)?.scheduled_counts),
          published: formatCountsFromJson(composerMetricsByProfileId.get(profile.id)?.published_counts),
        } satisfies ProfilePublicationMetrics : undefined,
        // A agenda ocupada melhora a prévia recorrente, mas não pode derrubar
        // a página quando a migration/coluna da fila ainda não está disponível.
        scheduled_post_count: composerMetricsByProfileId.get(profile.id)?.scheduled_post_count ?? 0,
        scheduled_execute_ats: stringArray(composerMetricsByProfileId.get(profile.id)?.scheduled_execute_ats),
        scheduled_execute_ats_by_format: scheduledSlotsFromJson(composerMetricsByProfileId.get(profile.id)?.scheduled_execute_ats_by_format),
        scheduled_by_time: stringArray(composerMetricsByProfileId.get(profile.id)?.scheduled_execute_ats).reduce<Record<string, number>>((counts, executeAt) => {
          const time = postingTimeWindow(executeAt);
          if (time) counts[time] = (counts[time] ?? 0) + 1;
          return counts;
        }, {}),
        scheduled_by_format_and_time: scheduledCountsByTime(scheduledSlotsFromJson(composerMetricsByProfileId.get(profile.id)?.scheduled_execute_ats_by_format)),
      }))}
      assets={assets}
      batches={[]}
      groups={groupsResult.data ?? []}
      assignments={assignmentsResult.data ?? []}
    />
  );
}
