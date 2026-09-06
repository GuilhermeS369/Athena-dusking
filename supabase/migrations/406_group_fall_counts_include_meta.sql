-- O contador "N cairam" do card de grupos passa a enxergar as quedas da Meta.
--
-- O QUE ESTAVA ERRADO. `app/(painel)/grupos/page.tsx` le
-- `zernio_group_profile_removal_counts` (migration 203), e essa view conhece
-- uma tabela so: `zernio_group_profile_removal_events`. Quando a queda pela
-- Meta ganhou rastro proprio -- tabelas espelhadas em vez de reaproveitadas,
-- pelos motivos escritos na migration 376 -- o XLSX foi ajustado (migration
-- 377) e o card ficou para tras. O desfecho e o mesmo que a 377 evitou na
-- planilha, e e o pior possivel para quem opera: o grupo encolhe, o perfil
-- some da lista, e o card diz "0 cairam". Quem olha conclui que perdeu um
-- perfil sem motivo, ou que o Athena perdeu o perfil.
--
-- O TAMANHO DISSO, medido em producao em 2026-09-06: 943 quedas Meta com
-- `counted_at` preenchido, em 14 grupos de 2 organizacoes, nenhuma visivel no
-- card -- contra 1.565 quedas Zernio, todas visiveis. Nao e um grupo especifico
-- nem uma organizacao especifica: e todo grupo cujo provedor virou Meta.
--
-- POR QUE UMA VIEW NOVA EM VEZ DE ESTENDER A ANTIGA. O nome
-- `zernio_group_profile_removal_counts` promete um provedor so, e continua
-- entregando exatamente isso -- quando a Zernio sair, ela sai junto com as
-- tabelas dela, como a 376 ja previu. A view nova nao cita provedor: e o lugar
-- onde o proximo entra sem que a tela precise saber.
--
-- NAO PRECISA DE BACKFILL. As duas tabelas de evento ja tem `counted_at`
-- preenchido nas 2.508 linhas existentes; o historico inteiro aparece no
-- instante em que a tela troca de fonte.
--
-- CONTA EVENTO, NAO PERFIL DISTINTO -- de proposito, e e a regra que a Zernio
-- ja aplicava sozinha: cada saida de grupo e uma queda. Um perfil que caiu,
-- voltou e caiu de novo caiu duas vezes.

create or replace view public.group_profile_fall_counts
with (security_invoker = true)
as
select
  event.organization_id,
  event.group_id,
  count(*)::integer as fallen_profile_count
from (
  select zernio_event.organization_id, zernio_event.group_id
  from public.zernio_group_profile_removal_events zernio_event
  where zernio_event.counted_at is not null
  union all
  select meta_event.organization_id, meta_event.group_id
  from public.meta_group_profile_removal_events meta_event
  where meta_event.counted_at is not null
) event
group by event.organization_id, event.group_id;

comment on view public.group_profile_fall_counts is
  'Quedas por grupo somando os dois provedores. E esta que a tela de grupos le; zernio_group_profile_removal_counts continua sendo so a metade Zernio.';

comment on view public.zernio_group_profile_removal_counts is
  'Metade Zernio das quedas por grupo. Para o numero que a operacao ve, use group_profile_fall_counts.';

revoke all on public.group_profile_fall_counts from public, anon;
grant select on public.group_profile_fall_counts to authenticated, service_role;

notify pgrst, 'reload schema';
