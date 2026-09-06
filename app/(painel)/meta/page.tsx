import { redirect } from 'next/navigation';

import MetaAppsClient, {
  type MetaApp,
  type MetaOrphanedProfile,
  type MetaTokenFleetRow,
} from '@/app/meta/meta-apps-client';
import { META_APP_SAFE_COLUMNS } from '@/lib/integrations/meta-apps';
import type { MetaPendingDisconnection } from '@/lib/integrations/meta-disconnections';
import { legacyMetaAppCredentials } from '@/lib/integrations/meta-oauth';
import {
  META_LONG_LIVED_TOKEN_DAYS,
  META_TOKEN_ALARM_AFTER_DAYS,
  META_TOKEN_REFRESH_AFTER_DAYS,
} from '@/lib/integrations/meta-token-renewal';
import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const ORPHANED_PROFILE_COLUMNS =
  'id, username, orphaned_from_meta_app_label, orphaned_at, last_error_message';

const PENDING_DISCONNECTION_COLUMNS =
  'id, profile_id, meta_app_id, username_snapshot, meta_app_label_snapshot, error_code, error_message, detected_at, signal';

export default async function MetaAppsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) redirect('/perfis');

  const supabase = await createSupabaseServerClient();
  const organizationId = context.activeOrganization.id;
  const [{ data, error }, { count: legacyProfileCount }, { data: fleet }, pending, orphaned] = await Promise.all([
    supabase
      .from('meta_apps_safe')
      .select(META_APP_SAFE_COLUMNS)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    // Perfis que entraram pela credencial global, antes do cadastro existir.
    // `orphaned_at` nulo separa esses dos que PERDERAM o app: os dois estão sem
    // vínculo, e só o primeiro grupo pode ser adotado pelo app do servidor.
    supabase
      .from('instagram_profiles_safe')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('provider', 'meta_official')
      .is('meta_app_id', null)
      .is('deleted_at', null)
      .is('orphaned_at', null),
    // Uma linha por app (e uma com meta_app_id nulo para os legados). Os
    // limites vão daqui para o banco, e não o contrário: a política é do
    // TypeScript, o banco só conta.
    supabase.rpc('meta_token_fleet_summary', {
      p_organization_id: organizationId,
      p_refresh_after_days: META_TOKEN_REFRESH_AFTER_DAYS,
      p_alarm_after_days: META_TOKEN_ALARM_AFTER_DAYS,
      p_expire_after_days: META_LONG_LIVED_TOKEN_DAYS,
    }),
    // Quedas que ainda seguram vaga no painel da Meta. A tela precisa da lista
    // inteira — é ela que o operador percorre conta por conta —, então pagina
    // em vez de confiar no teto do PostgREST: em 05/09/2026 eram 513 linhas,
    // 493 delas de um único dia. A ordem é por `id`, chave primária e portanto
    // ordem total; ordenar por `detected_at` sozinho repetiria linhas entre
    // páginas, já que uma leva de quedas compartilha o mesmo instante.
    fetchAllRows<MetaPendingDisconnection>((from, to) => supabase
      .from('meta_profile_disconnection_incidents')
      .select(PENDING_DISCONNECTION_COLUMNS)
      .eq('organization_id', organizationId)
      .is('slot_released_at', null)
      .order('id')
      .range(from, to)),
    // Perfis que perderam o app quando ele saiu do cadastro. Vivos, com fila
    // agendada, e sem publicar: o token foi emitido pelo app que sumiu. Ordem
    // por `id` porque é chave primária, logo ordem total — `orphaned_at` é o
    // mesmo instante para todos os perfis de um mesmo app e repetiria linhas.
    fetchAllRows<MetaOrphanedProfile>((from, to) => supabase
      .from('instagram_profiles_safe')
      .select(ORPHANED_PROFILE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('provider', 'meta_official')
      .is('meta_app_id', null)
      .is('deleted_at', null)
      .not('orphaned_at', 'is', null)
      .order('id')
      .range(from, to)),
  ]);

  if (error) {
    // Este throw derruba a tela inteira, então ele precisa carregar o bastante
    // para alguém depurar sem adivinhar. Em 05/09/2026 ele virou uma tela preta
    // com um digest e nada mais: a causa era `permission denied` numa coluna
    // nova de `meta_apps` que ninguém tinha concedido ao papel `authenticated`
    // (migration 398), e a mensagem não dizia nem qual consulta nem o código do
    // erro. Em produção o Next entrega só o digest ao navegador; o texto abaixo
    // vai para o log do servidor, que é onde ele serve para alguma coisa.
    console.error('[meta] falha ao carregar meta_apps_safe', {
      code: error.code, message: error.message, details: error.details, hint: error.hint,
    });
    throw new Error(
      `Não foi possível carregar os apps da Meta (meta_apps_safe): ${error.code ?? 'sem código'} — ${error.message}`,
    );
  }
  // A lista de quedas não derruba a tela: sem ela o painel continua servindo
  // para cadastrar app e renovar token, e o aviso é melhor que o erro 500.
  if (pending.error) console.error('[meta] falha ao carregar quedas pendentes', pending.error);
  if (orphaned.error) console.error('[meta] falha ao carregar perfis sem app', orphaned.error);

  return (
    <MetaAppsClient
      activeOrganization={context.activeOrganization}
      initialApps={(data ?? []) as MetaApp[]}
      unlinkedProfileCount={legacyProfileCount ?? 0}
      serverAppId={legacyMetaAppCredentials()?.clientId ?? null}
      initialTokenFleet={(fleet ?? []) as MetaTokenFleetRow[]}
      initialPendingDisconnections={pending.data}
      pendingDisconnectionsFailed={Boolean(pending.error)}
      initialOrphanedProfiles={orphaned.error ? [] : orphaned.data}
    />
  );
}
