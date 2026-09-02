-- Sobe o teto por minuto da Zernio de 600 para 1200.
--
-- MEDIDO NA ONDA DE 02/09/2026, 00:15 UTC (21:15 BRT) — 733 itens, a maior desde
-- que 185 perfis novos entraram:
--
--   00:15   209 criados
--   00:16   283      <- rajada: 598 em 2,2 min = 269/min
--   00:17   106
--           ... pausa de 5,5 minutos, nada sai ...
--   00:23    18
--   00:24    77
--
-- A pausa nao e aleatoria, e os numeros fecham exatamente:
--
--   teto por organizacao ...... 600/min
--   reservation_seconds ....... 300 s
--   criacoes antes da pausa ... 598   <- encostou no teto
--   duracao da pausa .......... 5,5 min  <- o tempo das reservas vencerem
--
-- Como a migration 340 ja documentava, `reserve_publication_dispatch_capacity`
-- soma ao teto TODAS as reservas ativas, nao so as publicacoes do ultimo minuto.
-- As 598 criacoes deixaram 598 reservas vivas por 300 s; o teto travou e nada
-- saiu ate elas expirarem. A onda levou 11 minutos para escoar em vez de ~3.
--
-- POR QUE ESTE TETO, E NAO A CONCORRENCIA: a telemetria do worker durante a mesma
-- onda mostrou `esperaPorSlot` com p50 de 1-2 ms e p90 de 4 ms. Com 733 itens as
-- 64 vagas de despacho NUNCA ficaram cheias. A concorrencia nao e o gargalo aqui.
--
-- POR QUE E SEGURO, e a diferenca que importa depois do incidente de 31/08:
-- este teto NAO controla paralelismo. Quantas conexoes simultaneas batem no
-- Supabase continua sendo definido por PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY,
-- que segue em 64. Subir o teto so faz o sistema parar de ADIAR — nao abre uma
-- conexao a mais. Foi exatamente essa distincao que faltou em 31/08, quando subi
-- a concorrencia (que controla conexao) achando que controlava vazao, e o
-- resultado foram 3.315 publicacoes perdidas.
--
-- O teto tambem nao e limite do provedor: a Zernio limita 25 posts/hora por
-- conta, e o pico medido por conta e 4/hora — folga de 6x. Este numero e
-- protecao nossa, do banco.
--
-- COMO REVERTER: um UPDATE devolvendo 600 nesta mesma linha. Sem migration
-- reversa, sem deploy, efeito imediato na proxima chamada da funcao.

update public.publication_rate_limit_settings
set max_provider_publications_per_minute = 1200,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'minute_limit_note',
      'Sobe de 600 para 1200 em 02/09/2026. Medido na onda de 733 itens das '
      || '00:15 UTC: 598 criacoes encostaram no teto de 600 (consumido pelas '
      || 'reservas em voo, de 300s) e a onda parou 5,5 min esperando elas '
      || 'vencerem, levando 11 min em vez de ~3. Este teto NAO controla '
      || 'paralelismo - conexao simultanea e definida por '
      || 'STAGED_DISPATCH_CONCURRENCY, que segue em 64. Ver '
      || 'docs/fila-de-publicacao-mapa-de-controles.md.'
    ),
    updated_at = timezone('utc', now())
where organization_id is null
  and provider = 'zernio';
