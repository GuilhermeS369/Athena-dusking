# Fase 05 — fila, workers, logs e shadow

Status: `completed`

## Entregas

- Migrations 229–232 aplicadas no Supabase vinculado.
- Holds individuais, claim por perfil, tentativas, lease, matriz financeira e cancelamento por escopo.
- Logs e resoluções imutáveis; decisão manual exige operador/admin e justificativa.
- Quatro roles operacionais de worker Twitter com heartbeat próprio e shadow sem chamada externa; o quinto papel vazio originalmente instalado foi removido pela ADR-X-017.
- Páginas `/x/fila`, `/x/agenda` e `/x/logs` isoladas.

## Evidências

- SQL: 18/18 (229), 16/16 (231), 9/9 (232), todos com rollback.
- Pós-teste: zero dados X residuais.
- Node: 154/154; TypeScript, build e diff check aprovados.
- Nenhuma FK `twitter_%` para tabelas operacionais Instagram.

## Correções e rollback

- 230 corrigiu forward-only a ambiguidade do claim em 229.
- 232 adicionou escopo por item/grupo e impede retry cego após chamada externa.
- Supabase alinhado até 232; Vercel/VPS não alterados; flags desligadas.
- Rollback: flags off, workers parados e correção de banco somente forward-only.

## Próxima ação segura

Adaptador Zernio live com fetch simulado. Canário real somente após API key X dedicada inserida por admin.

Auditoria final em 22/08/2026 detectou que o lock original abrangia somente `claimed`. A migration 241 ampliou o índice/claim para `claimed`, `processing` e `outcome_unknown`, além de priorizar retry futuro para impedir que outro item fure o backoff do perfil. Dry-run listou somente 241; aplicação remota aprovada; teste SQL transacional 5/5 e invariantes financeiros antes/depois idênticos.

Auditoria final posterior completou `/x/logs` com perfil, conexão, categoria de preço, custos estimado/liquidado, HTTP/código estável, request/post IDs, hold, reserva, valores restante/liquidado/devolvido, timeline de eventos/ledger e evidências persistidas. Tudo é obtido de tabelas `twitter_*`, sem leitura Zernio. Ações de reconciliação aparecem somente para operador/admin, exigem justificativa e informam que não repetem a chamada original. Cobertura total: 186/186 testes, TypeScript e build aprovados.

Auditoria de runtime em 22/08/2026: o papel `generation` somente autenticava heartbeat e não possuía claim ou responsabilidade. A ADR-X-017 removeu seu contrato, segredo, flag e entrada PM2. Publicação, sync, analytics e reconciliação permanecem isolados; o histórico anterior de cinco one-shots continua válido como evidência daquele release, não como topologia vigente.
