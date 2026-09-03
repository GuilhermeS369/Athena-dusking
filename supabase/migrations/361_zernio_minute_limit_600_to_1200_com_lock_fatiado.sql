-- Sobe o teto por minuto da Zernio de 600 para 1200, agora com o lock fatiado.
--
-- ESTE NUMERO JA SUBIU E JA DERRUBOU O SISTEMA. A migration 355 subiu para 1200
-- em 02/09 as 10:47; a queda veio as ~21h, e a 359 devolveu 600 na madrugada. O
-- que mudou desde entao nao e a avaliacao de risco: e o mecanismo.
--
-- POR QUE ERA PERIGOSO. O teto nao abre conexao, mas alonga o tempo que cada
-- despacho segura o advisory lock por organizacao em
-- reserve_publication_dispatch_capacity -- que serializava TUDO. Com 1200, o
-- dobro das chamadas percorria o caminho completo de insercao segurando o lock,
-- a fila migrou para dentro do Postgres, cada espera segurou uma conexao, e o
-- pool de 41 do PostgREST acabou. Ver secao 3-B de
-- docs/fila-de-publicacao-mapa-de-controles.md.
--
-- O QUE MUDOU. A migration 360 fatiou esse lock em 8 baldes por hash do perfil.
-- A contencao que antes era de N despachos num lock unico passa a ser N/8.
--
-- A EVIDENCIA, e ela e de uma onda so -- registrar isso importa. Em 03/09 as
-- 10:00 UTC passou uma onda de 2.797 itens, QUATRO VEZES a de 674 que derrubou o
-- sistema no dia anterior:
--
--   drenagem ....................... 13,3 min, 998 publicados, 1 falha
--   log de erro do worker .......... congelado, ZERO linhas novas
--   ConnectTimeout / PGRST002/003 .. zero
--   statement timeout (57014) ...... zero
--   load da VPS .................... 0,26
--   latencia do PostgREST .......... 78-101 ms
--
-- E o numero que separa contencao de banco de trabalho normal: porItemMs chegou
-- a 27.586 ms. Se fosse espera no lock, teria morrido nos 8 s do
-- statement_timeout e virado erro. Nao morreu -- o tempo e a chamada a API da
-- Zernio, nao o banco.
--
-- POR QUE SUBIR AGORA. Nessa mesma onda, as criacoes pararam por 7 minutos
-- (10:05 as 10:11) depois de 999 criacoes: as reservas de 300 s se acumularam e
-- encostaram no teto de 600. O teto e hoje o gargalo real e mensurado, e a
-- variavel que faltava -- a contencao no lock -- foi corrigida. Este e o
-- experimento isolado que a 355 nao pode ser.
--
-- O teto tambem nao e limite do provedor: a Zernio permite 25 posts/hora por
-- conta e o pico medido por conta e 4/hora. Folga de 6x. Este numero e protecao
-- nossa, do banco.
--
-- COMO REVERTER: `update public.publication_rate_limit_settings set
-- max_provider_publications_per_minute = 600 where organization_id is null and
-- provider = 'zernio'`. Efeito imediato na proxima chamada da funcao, sem
-- deploy. O gatilho para reverter e qualquer um destes, e nao "parece lento":
-- linha nova de ConnectTimeout ou PGRST00x no log do worker, statement timeout
-- 57014, ou authenticator encostando em 41 conexoes.
update public.publication_rate_limit_settings
set max_provider_publications_per_minute = 1200,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'minute_limit_note',
      'Sobe de 600 para 1200 em 03/09/2026, DEPOIS do lock de despacho ser '
      || 'fatiado em 8 baldes pela migration 360. A tentativa anterior (355) '
      || 'derrubou o sistema porque o teto alonga o tempo de posse de um lock '
      || 'que era unico por organizacao; fatiado, a contencao cai para 1/8. '
      || 'Evidencia: onda de 2.797 itens em 03/09 10:00 UTC (4x a de 674 que '
      || 'derrubou) drenou em 13,3 min com zero ConnectTimeout, zero PGRST00x, '
      || 'zero statement timeout e load 0,26. A mesma onda mostrou o teto de '
      || '600 travando a fila por 7 min apos 999 criacoes. Reverter: devolver '
      || '600 nesta linha. Ver docs/fila-de-publicacao-mapa-de-controles.md.'
    ),
    updated_at = timezone('utc', now())
where organization_id is null
  and provider = 'zernio';
