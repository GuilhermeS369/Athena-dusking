-- Sobe o teto por minuto da Zernio de 200 para 600, porque o teto antigo estava
-- sendo consumido em 76% por reservas em voo, e não por publicações.
--
-- MEDIDO EM PRODUÇÃO (30/08/2026, 22h26), durante uma onda:
--
--   publicados no último minuto ....  48
--   reservas ativas ................ 152
--   check_count .................... 200  <- exatamente o teto
--
-- `reserve_publication_dispatch_capacity` calcula o limite por minuto como:
--
--   check_count = publicados na última 1 minuto
--               + TODAS as reservas ativas (publication_dispatch_rate_reservations)
--
-- Ou seja, soma uma TAXA (por minuto) com uma CONCORRÊNCIA (reservas vivas, com
-- `reservation_seconds` de 300). Um item em voo continua contando muito depois do
-- minuto dele: entre o envio ao provedor e a confirmação passam ~75s (p50
-- medido), e nesse intervalo ele ocupa uma vaga do teto sem ser publicação nova.
--
-- Consequência: quanto mais rápido o sistema tenta ir, mais reservas ficam em
-- voo, e mais ele se auto-limita. A vazão real ficava presa em ~50 publicações
-- por minuto contra um teto nominal de 200 — um quarto do configurado. Foi o que
-- fez ondas de 450 a 512 itens levarem consistentemente ~10 minutos para escoar,
-- independentemente do tamanho: 512 em 10,3 min, 450 em 10,2 min, 189 em 10,3 min.
--
-- POR QUE NÃO MUDAR A FÓRMULA AGORA: contar as reservas existe por um motivo
-- legítimo — sem isso, uma rajada poderia disparar centenas de criações
-- simultâneas, já que nenhuma delas aparece como `published` ainda. A conta é
-- conservadora demais, não errada. Reescrever a função tocaria o caminho crítico
-- de toda publicação; ajustar o número entrega o ganho com risco muito menor, e
-- é reversível com um único UPDATE.
--
-- POR QUE 600: pela medição, cada publicação/minuto custa ~4 unidades do
-- check_count (1 dela mesma + ~3,2 de reservas em voo, na proporção 48:152).
-- Com 600, o teto passa a comportar ~140 publicações/minuto — quase 3x o atual.
-- Não vai a mais que isso de uma vez porque o objetivo é medir um degrau por vez;
-- a próxima parada natural, se a medição sustentar, é 1200.
--
-- QUAL É O RISCO REAL: este teto é proteção NOSSA, do banco, não do provedor.
-- Os limites de verdade da Zernio são 25 posts/hora por conta (medido: pico de
-- 4/hora, 16% do teto) e requisições por team. Nenhum dos dois é ameaçado aqui.
-- O que sobe é a concorrência contra o Supabase, hoje em Medium 4GB com CPU
-- abaixo de 30% e a VPS em 0,2 de load em 2 núcleos.
--
-- COMO REVERTER: um UPDATE devolvendo 200 na mesma linha. Sem migration reversa,
-- sem deploy, efeito imediato na próxima chamada da função.

update public.publication_rate_limit_settings
set max_provider_publications_per_minute = 600,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'minute_limit_note',
      'Sobe de 200 para 600 em 30/08/2026. O teto e consumido tambem por reservas '
      || 'em voo, que duram ate reservation_seconds: medido 48 publicados + 152 '
      || 'reservas = 200 no teto antigo, prendendo a vazao real em ~50/min. Ver '
      || 'docs/fila-de-publicacao-mapa-de-controles.md.'
    ),
    updated_at = timezone('utc', now())
where organization_id is null
  and provider = 'zernio';

comment on column public.publication_rate_limit_settings.max_provider_publications_per_minute is
  'Teto por organizacao e provedor. ATENCAO: reserve_publication_dispatch_capacity compara este valor contra publicados no ultimo minuto MAIS as reservas ativas, entao ele nao e vazao pura - cada publicacao/minuto custa ~4 unidades por causa dos itens em voo. Ver docs/fila-de-publicacao-mapa-de-controles.md antes de ajustar.';
