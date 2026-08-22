# Fase 07 — análises manuais

Status: `completed`

## Entregas

- `/x/analises` seleciona posts e perfis com checkbox.
- Quote é somente leitura, assinado e válido por dez minutos.
- Confirmação bloqueia todas as carteiras, revalida versões e preserva US$ 5,00 além de reservas existentes.
- Post custa 5.000 micros; perfil/followers custa 10.000 micros.
- Worker analytics usa rotas, flag, heartbeat e endpoints Zernio próprios.
- Sucesso liquida somente o recurso e cria snapshot local; falha confirmada libera; incerto mantém hold.
- Dashboard X lê apenas snapshots locais e nunca dispara coleta.
- `/x/logs` permite resolver analytics incerta com justificativa auditada.

## Evidências

- Migration 235–239 aplicadas; Supabase alinhado até 239.
- Teste SQL 26/26 com rollback e zero resíduos.
- 163/163 testes Node, TypeScript, build e diff check aprovados.
- Lint sem achados X; achados legados inalterados.
- Nenhuma chamada real Zernio foi feita; flags analytics permanecem off.

## Rollback

- Manter `TWITTER_ANALYTICS_ENABLED=false` e `TWITTER_ANALYTICS_WORKER_ENABLED=false`.
- Parar apenas `athena-twitter-analytics-worker` quando instalado.
- Banco recebe somente correção forward-only; código pode ser revertido pelo commit da fase.

## Próxima ação segura

Deploy preview com flags X desligadas, smoke test e instalação dos workers X em shadow/parados.
