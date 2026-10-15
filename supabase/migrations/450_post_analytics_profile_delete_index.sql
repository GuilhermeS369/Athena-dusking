-- Índice para o DELETE de métricas por post do perfil removido (medição de 15/10/2026).
--
-- soft_delete_profile_analytics (385), chamada pelo finalizador de queda Meta
-- (finalize_meta_profile_disconnection_for_profile, 448) a cada perfil derrubado, faz
--
--   delete from profile_post_analytics_snapshots
--   where profile_id = $1 and organization_id = $2
--
-- sem `deleted_at is null` — de propósito, apaga também linha marcada. O único índice
-- em (organization_id, profile_id) é parcial `where deleted_at is null`
-- (profile_post_analytics_snapshots_profile_published_idx), então o planejador não o
-- usa e varre a tabela inteira (940 MB de heap, 533 mil linhas) a cada queda.
--
-- pg_stat_statements de 13/10 13:53 a 15/10 12:40 BRT (47,8 h): 833 chamadas de
-- finalize_meta_profile_disconnection leram 319 GB do disco/cache do SO, 91% de toda a
-- leitura do banco no período (~390 MB por queda). Era o que impedia reduzir o compute
-- do Medium (39 MB/s de disco base) para o Small (22 MB/s): uma onda de checkpoint
-- gastava a cota de IO.
--
-- Índice comum, sem parcial, para o DELETE servir com ou sem linha marcada. Criação
-- comum (não `concurrently`): construído em produção antes desta migration com
-- `create index concurrently`. Aqui fica o `if not exists` para o histórico e para
-- ambientes novos.
--
-- De carona: profile_post_analytics_snapshots_item_fk_idx é cópia exata de
-- profile_post_analytics_snapshots_item_idx (publication_item_id where not null).
-- O _item_idx atende a FK (3,6 mi de buscas), o _item_fk_idx tinha 0 uso.

create index if not exists profile_post_analytics_snapshots_profile_idx
  on public.profile_post_analytics_snapshots (organization_id, profile_id);

drop index if exists public.profile_post_analytics_snapshots_item_fk_idx;
