-- App da Meta ganha estado de bloqueio, com janela que expira sozinha.
--
-- O QUE ACONTECEU EM 05/09/2026. A Meta devolveu `code 200 / "API access
-- blocked."` para 4 apps de 28 -- 169 perfis, 11.973 publicações agendadas. O
-- código tratou aquilo como falha de item: 200 não é retentável, então 136
-- reels morreram em definitivo, o disjuntor viu falhas consecutivas e pausou 3
-- lotes. Um deles, `Julio / 05/09 / Reels`, mistura os dois apps do Julio, e a
-- pausa congelou 6.120 itens de um app que estava saudável.
--
-- A UNIDADE ERRADA. Bloqueio de "API access blocked" não é do item nem do lote:
-- é do APP. Enquanto ele durar, nenhum perfil daquele app publica, e todo item
-- que encostar nele morre. Tratar item por item multiplica o prejuízo pelo
-- número de itens; tratar por lote atinge apps saudáveis que dividem o lote.
--
-- O DESENHO, decidido pelo operador: bloqueio NÃO REPRESA FILA. Ao detectar,
-- marca-se o app por uma hora e descarta-se o que vence nessa janela. Passada a
-- hora a janela expira, e o próximo item que vencer é tentado -- ou seja, a
-- própria fila é a sonda de desbloqueio, sem nenhum processo extra. Falhou de
-- novo, abre-se outra janela de uma hora.
--
-- POR QUE `api_block_until` E NÃO UM BOOLEANO. "Bloqueado agora" é
-- `api_block_until > now()`. Não existe flag para alguém esquecer de limpar: a
-- janela expira sozinha, e é isso que faz o desenho funcionar sem worker de
-- sonda. `api_blocked_at` guarda o início do incidente, para a tela dizer "há
-- quanto tempo"; os contadores existem para a tela dizer o tamanho do estrago.
alter table public.meta_apps
  add column if not exists api_blocked_at timestamptz,
  add column if not exists api_block_until timestamptz,
  add column if not exists api_block_error_message text,
  add column if not exists api_block_detected_item_id uuid
    references public.publication_items(id) on delete set null,
  add column if not exists api_block_window_count integer not null default 0,
  add column if not exists api_block_ignored_count integer not null default 0,
  add column if not exists api_last_unblocked_at timestamptz,
  add column if not exists api_unblocked_by uuid
    references auth.users(id) on delete set null;

alter table public.meta_apps
  drop constraint if exists meta_apps_api_block_counts_check;
alter table public.meta_apps
  add constraint meta_apps_api_block_counts_check
  check (api_block_window_count >= 0 and api_block_ignored_count >= 0);

-- O claim consulta isto a cada despacho. O índice parcial mantém a leitura
-- barata quando não há bloqueio nenhum, que é o estado normal.
create index if not exists meta_apps_api_block_until_idx
  on public.meta_apps (api_block_until)
  where api_block_until is not null;

-- E este resolve o outro lado da mesma consulta. O índice que já existia
-- (`instagram_profiles_org_meta_app_idx`, migration 366) começa por
-- `organization_id`, e a lista de perfis bloqueados é global -- o bloqueio é do
-- app, não da organização. Sem um índice que comece por `meta_app_id`, cada
-- claim varreria os 5.235 perfis da tabela, dentro da transação mais quente do
-- sistema. Foi tempo de lock dentro do claim que esgotou o pool em 02/09.
create index if not exists instagram_profiles_meta_app_lookup_idx
  on public.instagram_profiles (meta_app_id)
  where meta_app_id is not null and deleted_at is null;

notify pgrst, 'reload schema';
