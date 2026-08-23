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

## ADR-X-014 — heartbeat parado é o kill switch autoritativo do worker

- Data: 22/08/2026
- Decisão: cada papel possui um flag próprio, incluindo `TWITTER_RECONCILE_WORKER_ENABLED`. O endpoint de heartbeat retorna `stopped` quando o papel/rollout não está autorizado e o executável encerra o ciclo imediatamente. Claims, reconciliação e fallback também reaplicam o gate global/canário em chamadas diretas.
- Motivo: parar apenas publicação/analytics deixava a recuperação de reconciliação capaz de executar com o módulo desligado; também não bastava o servidor responder `stopped` se o processo ignorasse esse modo.
- Consequência: um one-shot com flags off pode provar autenticação e pareamento sem mutação operacional. Ativar um papel exige habilitar explicitamente somente seu flag e os gates adicionais aplicáveis.

## ADR-X-015 — revisão proporcional ao saldo e lock por perfil até reconciliação

- Data: 22/08/2026
- Decisão: o calendário de até 90 dias é calculado sob demanda; somente itens financiados são materializados. Um perfil fica bloqueado enquanto existir item `claimed`, `processing` ou `outcome_unknown`; retries futuros têm prioridade sobre novos itens do mesmo perfil.
- Motivo: materializar 129.601 minutos por perfil tornava Revisar pesado apesar do teto de 800 posts baratos por carteira. Bloquear apenas `claimed` permitia novo envio após aceite ainda pendente e furava o backoff de 429.
- Consequência: custo da revisão passa a ser limitado pelo saldo e pelo ciclo de combinações. Um resultado aceito/incerto precisa ser reconciliado antes de o perfil voltar a enviar.

## ADR-X-016 — sincronização de perfis sai do request Vercel

- Data: 22/08/2026
- Decisão: o botão Sincronizar cria um `twitter_sync_job` idempotente. O worker VPS exclusivo lê contas/health da Zernio, força `analytics=false` e `inbox=false`, e envia somente o inventário sanitizável para persistência. Claim usa lease e token renovado; uma conexão possui no máximo um job ativo.
- Motivo: executar duas leituras externas e updates por conta dentro do request público expõe a sincronização a timeout da Vercel e mistura o papel da interface com processamento operacional.
- Consequência: a UI acompanha o job por polling local; nenhuma API key retorna ao navegador ou ao payload de resultado. A migration 242 e o worker permanecem desligados até teste transacional e one-shot off.

## ADR-X-017 — geração financiada permanece na confirmação atômica

- Data: 22/08/2026
- Substitui parcialmente: ADR-X-013 quanto à existência de cinco processos e cinco segredos de worker; os isolamentos por papel permanecem válidos para os quatro processos reais.
- Decisão: remover o papel, processo, segredo e kill switch `generation` do runtime X. A confirmação transacional continua materializando somente os itens que a carteira financia. O runtime passa a ter publicação, sync, analytics e reconciliação.
- Motivo: não existe trabalho pendente legítimo depois da confirmação. Tornar a materialização assíncrona permitiria saldo reservado sem fila pronta; manter um processo sem função aumentaria a superfície operacional e de autenticação sem benefício.
- Consequência: confirmação falha por inteiro ou cria reserva e itens financiados na mesma transação. Novas responsabilidades assíncronas só poderão criar um quinto papel mediante ADR própria, fila/claim idempotentes, invariantes financeiras e gate de isolamento — nunca reutilizando um processo artificial vazio.

## ADR-X-018 — transferência exige administração bilateral e idempotência

- Data: 22/08/2026 (America/Sao_Paulo)
- Decisão: transferir uma identidade global somente quando o mesmo usuário for admin nas organizações de origem e destino, ambas estiverem habilitadas para o módulo X, não houver conexão ativa nem reserva aberta e a chamada trouxer idempotency key inédita. A RPC antiga sem idempotência perde execução para `service_role`.
- Motivo: um admin de tenant não deve escolher uma organização que não administra; repetição de request não pode duplicar evento nem incrementar versão da carteira novamente.
- Consequência: saldo restante e carteira migram sem nova concessão; ledger, posts e histórico permanecem imutáveis; filas, grupos e conexões nunca são recriados no destino. Cada transferência produz um evento imutável visível a admins relacionados.

## ADR-X-019 — capabilities da Zernio são controladas pelo Athena e possuem gate exclusivo

- Data: 22/08/2026 (America/Sao_Paulo).
- Substitui parcialmente: ADR-X-008 e ADR-X-016 apenas quanto a Analytics ser sempre forçado para `false` durante toda sincronização.
- Decisão: Inbox permanece invariavelmente `false`. Analytics continua `false` por padrão, mas um Admin pode alterar a capability das contas X pelo Athena, com justificativa, idempotência, evento imutável e propagação para todas as épocas ativas da conexão. Ativar exige simultaneamente o escopo do módulo, `TWITTER_ANALYTICS_ENABLED=true` e o gate exclusivo `TWITTER_ZERNIO_ANALYTICS_SYNC_ENABLED=true`; desativar permanece possível para falhar fechado.
- Motivo: a documentação oficial da Zernio define `xCapabilities.analytics` e `xCapabilities.inbox` como opt-in, ambos `false` por padrão. Analytics ligado autoriza sincronização periódica cobrada, portanto ele não pode acompanhar automaticamente o gate das leituras manuais nem depender de acesso humano ao painel Zernio.
- Consequência: um fluxo novo `Usuário → Athena → Zernio → X` nasce com ambos desligados. Quando o gate exclusivo for aprovado, o Athena poderá ligar Analytics sem o usuário abrir a Zernio; o worker de sync reaplica o estado auditado e sempre força Inbox desligado. Falha parcial ao ligar executa compensação para `false`. A migration 244 não ativa a conexão existente e não gera leitura X.
