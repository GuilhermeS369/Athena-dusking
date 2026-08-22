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

## ADR-X-011 — HTTP 202 não medido permite nova operação manual após sincronização

- Data: 22/08/2026
- Substitui parcialmente: ADR-X-006 apenas para analytics HTTP 202 comprovadamente não medido.
- Decisão: um attempt HTTP 202 continua terminal e nunca recebe retry automático. Depois de duas conferências `GET /v1/usage` provarem ausência de `posts_read`, ele é reconciliado como não cobrado. Uma nova solicitação do mesmo recurso pode ser criada somente por novo quote/confirm manual, nova reserva, novo item e checkpoint, pois a documentação Zernio define 202 como sincronização pendente.
- Motivo: consultar sempre um post diferente repete a primeira sincronização de cada recurso e não testa o caminho documentado de snapshot já sincronizado.
- Consequência: preserva-se a proibição de retry cego, mas o gate pode testar o mesmo post posteriormente sem reutilizar attempt, idempotency key ou hold anteriores.

## ADR-X-012 — ativação progressiva é aplicada em página, API e analytics

- Data: 22/08/2026
- Decisão: com `TWITTER_MODULE_ENABLED=false`, a lista `TWITTER_CANARY_ORGANIZATION_IDS` habilita organizações individualmente; com a flag global true, habilita todas. Páginas `/x/*` e todas as APIs públicas X reaplicam esse escopo. Analytics exige sua própria flag e o mesmo escopo organizacional.
- Motivo: esconder apenas o menu não impede acesso direto por URL/API, e uma flag global de analytics isolada poderia criar custo fora do canário.
- Consequência: o webhook Zernio permanece fora do gate de UI por ser autenticado por HMAC e necessário para reconciliar operações iniciadas; toda outra rota pública X exige contexto organizacional. O health global considera o rollout ativo quando existe ao menos um canário.

## ADR-X-013 — segredo independente por processo e função operacional

- Data: 22/08/2026
- Decisão: publicação, geração, sync, analytics e reconciliação usam cinco segredos distintos; heartbeat/circuit breaker vinculam o segredo ao nome do processo. Fallback e health usam outros dois segredos exclusivos.
- Motivo: um segredo compartilhado ampliava o raio de comprometimento e não atendia ao requisito de segredo próprio de cada worker.
- Consequência: rotação e deploy precisam manter pareamento Vercel/VPS por papel. O nome genérico legado será removido após a validação do novo release e nunca será fallback silencioso.
