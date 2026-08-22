# Decisões arquiteturais — módulo X/Twitter

Decisões são append-only. Mudanças exigem nova ADR que substitua explicitamente a anterior.

## ADR-X-001 — módulo fisicamente isolado

- Data: 22/08/2026
- Decisão: usar páginas, APIs, tabelas, bucket, RPCs e workers `twitter_*` próprios.
- Motivo: preservar o Instagram e limitar o raio de falha.
- Consequência: algum código será duplicado inicialmente em vez de generalizar estruturas ativas.

## ADR-X-002 — Zernio como único conector

- Decisão: toda conexão e operação X usa a Zernio.
- Consequência: respostas externas precisam de idempotência, sanitização e reconciliação.

## ADR-X-003 — carteira sintética local

- Decisão: conceder uma vez US$ 12,00 por `userId` Zernio global; armazenar tudo em micros e ledger imutável.
- Consequência: billing da Zernio é diagnóstico e nunca redefine o saldo Athena.

## ADR-X-004 — reserva agregada e confirmação atômica

- Decisão: review é read-only; confirm bloqueia carteira, revalida snapshot e reserva somente slots financiáveis.
- Consequência: mudança concorrente responde 409 e exige nova revisão.

## ADR-X-005 — distribuição sob saldo baixo

- Decisão: round-robin determinístico, procurando slots sem URL quando slots mais caros não couberem.
- Consequência: excedentes ficam terminais no programa e não retomam após devoluções futuras.

## ADR-X-006 — resultado incerto não permite retry cego

- Decisão: timeout/5xx incerto cria `outcome_unknown`, mantém hold e exige reconciliação.
- Consequência: logs financeiros e resolução auditada são parte do núcleo, não observabilidade opcional.

## ADR-X-007 — perfis estáveis com épocas de conexão

- Decisão: identidade pelo ID imutável do X e histórico em `twitter_profile_connection_epochs`.
- Consequência: username não prova identidade e filas antigas não migram para nova conexão.

## ADR-X-008 — analytics somente manual

- Decisão: `analytics=false` e `inbox=false` por padrão; quote/confirm manual e piso protegido de US$ 5,00.
- Consequência: Dashboard lê snapshots locais e publicação conserva prioridade financeira.

## ADR-X-009 — agenda e retry

- Decisão: intervalo mínimo de 1 minuto; após 429, retry em `max(Retry-After, 4 minutos)`; uma chamada por perfil.
- Consequência: o intervalo configurado não é confundido com a recuperação de velocity limit.

## ADR-X-010 — documentação é parte do gate

- Decisão: código não avança de fase sem README, STATE, execution log, evidências, rollback e commit.
- Consequência: uma nova conta GPT deve conseguir continuar sem o histórico da conversa.
