import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isLegacySchedulingEnabled, LEGACY_SCHEDULING_DISABLED_MESSAGE } from '@/lib/publications/legacy-scheduling';
import { bulkPublishingEnabled } from '@/lib/publications/bulk-feature';
import { isBulkVideoVariantAllowed } from '@/lib/publications/bulk-api';
import { Suspense } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';
import PublishingClient from '@/app/postagem/publishing-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { signMediaPreviewUrl } from '@/lib/storage/media-storage';
import { emptyScheduledCountsByFormat } from '@/lib/publications/composer';

export const dynamic = 'force-dynamic';

// Modos antigos de agendar desativados (LEGACY_SCHEDULING_ENABLED): a rota
// continua existindo, mas mostra o aviso em vez do compositor. Nada é lido do
// banco neste caminho; o compositor abaixo segue intacto e volta com a flag.
function LegacySchedulingDisabledNotice() {
  return (
    <main className="standalone-page">
      <div className="panel empty-state" role="status">
        <span className="section-kicker">Postagem</span>
        <h1>Programação desativada</h1>
        <p>{LEGACY_SCHEDULING_DISABLED_MESSAGE}</p>
        <Link className="button button-secondary" href="/grupos">Ir para Grupos</Link>
      </div>
    </main>
  );
}

export default function PublishingPage() {
  if (!isLegacySchedulingEnabled()) return <LegacySchedulingDisabledNotice />;

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
  const [profilesResult, assetsResult, groupsResult] = await Promise.all([
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
    // As CONTAGENS por perfil não vêm mais daqui. Elas eram lidas para a
    // organização inteira, e em 06/09/2026 passaram a estourar o
    // `statement_timeout` de 8 s (8.612 ms, código 57014): a tabela quente saiu
    // de 404.753 linhas, quando esta chamada foi escrita, para 536.592. Como as
    // falhas de leitura desta página são engolidas de propósito logo abaixo, o
    // estouro não aparecia como erro — aparecia como todos os perfis marcando 0
    // agendadas, com 87 mil publicações na fila.
    //
    // Agora seguem o mesmo caminho que os horários ocupados já seguiam: lidas
    // sob demanda em /api/publications/composer/summaries, só para os perfis do
    // destino escolhido. A janela contada continua inteira — o que mudou é para
    // quem se conta, não quanto.
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
  console.info('/postagem carregada', {
    organizationId,
    onlineProfiles: profilesResult.data?.length ?? 0,
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
      bulkVideoVariantAvailable={isBulkVideoVariantAllowed(context.activeOrganization.id)}
      // Os horários ocupados de cada perfil NÃO vão aqui. Eram 89% destas props
      // (13,8 MiB para 1.401 perfis, 367.744 timestamps) e só são lidos depois
      // de escolher um destino — o cliente os busca em /api/publications/composer/slots
      // para os perfis daquele destino.
      // As contagens de cada perfil também NÃO vão aqui, pelo mesmo motivo dos
      // horários ocupados logo acima: são lidas depois, para os perfis do
      // destino escolhido. O que sai do servidor é o perfil zerado; o cliente
      // preenche quando há destino.
      profiles={(profilesResult.data ?? []).map((profile) => ({
        ...profile,
        scheduled_post_count: 0,
        scheduled_by_time: {},
        scheduled_by_format_and_time: emptyScheduledCountsByFormat(),
      }))}
      assets={assets}
      batches={[]}
      groups={groupsResult.data ?? []}
      assignments={assignmentsResult.data ?? []}
    />
  );
}
