-- Athena Scheduler: os perfis Zernio entram em transição para a API da Meta.
--
-- POR QUE MARCAR. Em 04/09/2026 a Zernio suspendeu 2.004 das 2.166 conexões
-- ativas (100% das da Pomodoro): a API devolve 401 para chaves que funcionavam
-- horas antes. Os perfis continuam com `status = 'online'` no Athena, o que é
-- falso — eles não publicam. Enquanto disserem "online", aparecem em /postagem,
-- na dashboard e na recuperação como se estivessem operando, e a operação
-- planeja em cima de capacidade que não existe.
--
-- O QUE ISTO FAZ. Marca todo perfil Zernio ativo como precisando de
-- reautorização, que é a situação real: para voltar, a conta precisa ser
-- reconectada — agora pela API oficial da Meta. O perfil sai desse estado
-- sozinho quando `connect_meta_instagram_profile` (migration 373) o assume:
-- aquela função devolve status para 'online' e limpa o erro.
--
-- O QUE ISTO NÃO FAZ. Não apaga nada, não desconecta nada e não toca em
-- histórico: métricas, grupos e posts seguem intactos e voltam a aparecer
-- assim que o perfil for reconectado. É uma mudança de situação, reversível
-- por `update ... set status = 'online', last_error_code = null` filtrando por
-- last_error_code = 'zernio_provider_suspended'.
--
-- ATENÇÃO OPERACIONAL: o worker de sincronia da Zernio, se voltar a rodar,
-- devolveria estes perfis para 'online' ao consultar a API dela. Enquanto a
-- migração estiver em curso, ele deve seguir parado.

-- A primeira tentativa morreu em 57014 (statement timeout) — não por volume, e
-- sim pelo teto curto da conexão de migração. Medido antes de mexer: 25 linhas
-- em 713 ms, com ~3 ms marginais por linha, o que projeta ~11 s para as 3.293.
-- O teto é elevado só nesta transação; se levar minutos, o problema é outro e
-- é melhor a migração falhar do que segurar a tabela indefinidamente.
set local statement_timeout = '300s';

update public.instagram_profiles
set status = 'reauthorization_required',
    last_failure_at = timezone('utc', now()),
    last_error_code = 'zernio_provider_suspended',
    last_error_message = 'A Zernio suspendeu esta conexão. Reconecte o perfil pela API oficial da Meta em /perfis — o histórico de views e os grupos são preservados.'
where provider = 'zernio'
  and deleted_at is null
  and status <> 'reauthorization_required';

notify pgrst, 'reload schema';
