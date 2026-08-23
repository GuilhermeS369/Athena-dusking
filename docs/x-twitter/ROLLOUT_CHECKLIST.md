# Checklist de rollout progressivo — X/Twitter

Este checklist é operacional e não autoriza ativação. Todos os gates precisam estar aprovados no mesmo checkpoint.

## Gate zero — obrigatório antes de qualquer expansão

- [x] Zernio retornou HTTP 200 para analytics manual de um recurso canário.
- [x] Snapshot local criado e custo exato liquidado (zero unidades observadas); zero hold ou outcome incerto.
- [x] `/api/internal/twitter-rollout-health` retorna `ok`, zero breakers abertos, zero unknowns e zero 429 na janela observada.
- [x] Production está `READY` no deployment documentado, com smoke de login e rotas X.
- [x] Quatro processos X PM2 e seis processos existentes conferidos separadamente; fallback Vercel não é processo PM2.
- [x] Supabase local/remoto alinhado e nenhuma migration pendente.
- [x] Testes, TypeScript, build e `git diff --check` aprovados no commit candidato.
- [x] Rollback Vercel/VPS e IDs exatos registrados.
- [x] Gate visual/CSS de todas as rotas `/x/*` aprovado nos breakpoints documentados, com regressão das telas Instagram que usam estilos compartilhados.

Estado em 23/08/2026 10:40 BRT: nove de nove itens aprovados. O rollout global foi observado por 30 minutos com 31 amostras `ok`: zero fila, hold, unknown, breaker, 429, sinal crítico ou aviso. Snapshot Analytics 1; wallet 11.590.000/0; quatro workers X ativos e fallback desligado.

## Semântica das flags

- `TWITTER_MODULE_ENABLED=false` + `TWITTER_CANARY_ORGANIZATION_IDS=<ids>`: somente organizações listadas veem páginas e acessam APIs X.
- `TWITTER_MODULE_ENABLED=true`: módulo disponível para todas as organizações.
- Analytics exige também `TWITTER_ANALYTICS_ENABLED=true`; enquanto o módulo global estiver off, só funciona para organizações canário.
- Claims de analytics exigem ainda `TWITTER_ANALYTICS_WORKER_ENABLED=true`.
- Fallback live exige as quatro condições independentes já descritas no runbook; nunca inferir autorização por uma única flag.

## Expansão controlada

1. Manter a flag global false e adicionar uma organização por vez à lista canário.
2. Fazer deploy Production com workers X ainda parados; validar navegação/API dentro e fora da organização habilitada.
3. Iniciar somente os workers X necessários, concorrência 1, sem tocar processos Instagram.
4. Observar no mínimo 30 minutos antes de adicionar a próxima. Organização com conexão X ativa exige uma publicação confirmada; organização sem conexão exige estados vazios/permissões e prova de zero chamada externa, fila, reserva ou ledger.
5. Exigir health `ok` antes e depois de cada expansão; registrar fila, holds, wallet, attempts, 429, breakers, heartbeats e PM2.
6. Somente após todas as organizações selecionadas permanecerem estáveis, considerar `TWITTER_MODULE_ENABLED=true`.
7. Analytics e fallback live são expansões separadas; não ativar ambos no mesmo checkpoint da liberação global.

Inventário atual: três organizações, uma com conexão X ativa e duas sem conexão. Não documentar nomes adicionais nem criar conexões artificiais para o rollout.

Conclusão: a organização conectada já cumpriu os canários reais de publicação e financeiro. As duas organizações sem conexão cumpriram o aceite aplicável por estados vazios, proteção de rotas, isolamento e ausência de dados/chamadas externas. Uma conexão futura inicia seu próprio gate de primeiro envio.

## Critérios de pausa imediata

- qualquer `outcome_unknown`, hold/reserva financeira incerta ou diferença wallet × ledger;
- breaker aberto, worker esperado stale ou claim duplicado por perfil;
- cobrança sem ledger, devolução duplicada ou saldo negativo/ultrapassado;
- erro de isolamento entre organizações;
- alteração de PID/status ou regressão funcional dos workers Instagram;
- HTTP 429: não expandir enquanto existir ocorrência na janela de observação;
- aumento inesperado de CPU, memória ou disco da VPS.

## Rollback sem perda de histórico

1. Remover a organização recém-adicionada da lista ou definir a flag global false.
2. Desligar flags de claim/fallback e parar somente processos `athena-twitter-*`.
3. Preservar items iniciados/unknowns para reconciliação; liberar apenas reservas comprovadamente não iniciadas.
4. Retornar ao deployment/release documentado anterior sem apagar tabelas, ledger, logs ou releases.
5. Confirmar novamente seis processos existentes online, health X e invariantes financeiras.
6. Registrar `rolled_back`, causa, evidências e próxima ação segura no STATE/log da fase.
