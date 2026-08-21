# Runbook — teste de carga da fila

Use preferencialmente em staging. Em produção, rode apenas com itens futuros ou com workers reais pausados.

## 1. Configurar variáveis

```bash
LOAD_TEST_ID=teste-001
LOAD_TEST_ORGANIZATION_ID=uuid-da-organizacao
LOAD_TEST_PROFILE_LIMIT=10
LOAD_TEST_POSTS_PER_PROFILE=24
LOAD_TEST_START_OFFSET_MINUTES=43200
LOAD_TEST_MINUTES_BETWEEN_POSTS=60
```

Por padrão, `LOAD_TEST_START_OFFSET_MINUTES=43200` agenda itens 30 dias no futuro, evitando publicação real por engano.

## 2. Criar carga futura segura

```bash
npm run load-test:seed
npm run load-test:report
```

Para smoke inicial em produção, prefira o script autocontido abaixo. Ele cria itens 30 dias no futuro, mede a inserção, valida o aumento temporário de fila e remove o lote ao final sem reivindicar itens nem chamar Meta/Zernio:

```bash
LOAD_TEST_ID=phase8-safe-smoke-001 \
LOAD_TEST_PROFILE_LIMIT=10 \
LOAD_TEST_POSTS_PER_PROFILE=24 \
LOAD_TEST_START_OFFSET_MINUTES=43200 \
npm run load-test:safe-smoke
```

Guardrails do smoke seguro:

- `LOAD_TEST_START_OFFSET_MINUTES` não aceita valores menores que 60 minutos.
- O script não chama `claim_publication_items`.
- O script não chama `complete_publication_item`.
- O script não faz requisições para Meta ou Zernio.
- A limpeza acontece apagando o lote sintético, com cascata para os itens criados.

Para validar cardinalidade de perfis sem depender de perfis reais conectados, use o teste sintético isolado. Ele cria organizações e perfis sintéticos com provedor `zernio`, agenda itens futuros, mede health/fila e remove a organização inteira ao final:

```bash
LOAD_TEST_ID=phase8-synthetic-100x24-001 \
LOAD_TEST_SYNTHETIC_ORGANIZATIONS=1 \
LOAD_TEST_SYNTHETIC_PROFILES_PER_ORG=100 \
LOAD_TEST_POSTS_PER_PROFILE=24 \
LOAD_TEST_TOTAL_ITEM_LIMIT=3000 \
LOAD_TEST_START_OFFSET_MINUTES=43200 \
npm run load-test:synthetic-scale
```

Para o degrau de 300 perfis:

```bash
LOAD_TEST_ID=phase8-synthetic-300x24-001 \
LOAD_TEST_SYNTHETIC_ORGANIZATIONS=1 \
LOAD_TEST_SYNTHETIC_PROFILES_PER_ORG=300 \
LOAD_TEST_POSTS_PER_PROFILE=24 \
LOAD_TEST_TOTAL_ITEM_LIMIT=8000 \
LOAD_TEST_START_OFFSET_MINUTES=43200 \
npm run load-test:synthetic-scale
```

O script sintético possui limite de segurança por padrão em 10.000 itens e só ultrapassa esse valor se `LOAD_TEST_TOTAL_ITEM_LIMIT` for elevado explicitamente. Para manter dados sintéticos para inspeção manual, definir `LOAD_TEST_KEEP_DATA=true`; caso contrário, a limpeza é automática.

## 3. Simular processamento

Para testar claim/conclusão, os itens precisam estar vencidos ou due. Faça isso apenas em staging ou com cron/worker real pausado:

```bash
LOAD_TEST_ALLOW_DUE_ITEMS=true LOAD_TEST_START_OFFSET_MINUTES=-10 npm run load-test:seed
LOAD_TEST_CLAIM_LIMIT=5 LOAD_TEST_MAX_CYCLES=20 LOAD_TEST_SIMULATED_DELAY_MS=100 npm run load-test:simulate
npm run load-test:report
```

## 4. Limpar dados do teste

```bash
npm run load-test:cleanup
```

## 5. Degraus recomendados

| Etapa | `LOAD_TEST_PROFILE_LIMIT` | `LOAD_TEST_POSTS_PER_PROFILE` | Total aproximado |
|---|---:|---:|---:|
| Validação | 10 | 24 | 240 |
| Pequeno | 100 | 24 | 2.400 |
| Empresário | 300 | 24 | 7.200 |
| Intermediário | 1000 | 24 | 24.000 |
| Meta diária | 3000 | 24 | 72.000 |

## 6. Métrica de aceite inicial

- Mínimo: 50 itens por minuto em simulação.
- Confortável: 100 a 150 itens por minuto em simulação.
- Sem leases vencidos crescentes.
- Sem CPU da VPS travada em 100% por longos períodos.

## 7. Resultado inicial da Fase 8 em produção

Em 2026-08-11, foi executado um smoke seguro em produção com `LOAD_TEST_ID=phase8-safe-smoke-002`:

- Organização: Pomodoro (`58785306-4dfb-432f-8de0-f0b33f91f3de`).
- Perfis usados: 10.
- Itens por perfil: 24.
- Total sintético: 240 itens.
- Agendamento: 30 dias no futuro.
- Inserção: 240 itens em 1.290 ms, aproximadamente 186 itens/s.
- Fila antes: 175 itens ativos.
- Fila durante o teste: 415 itens ativos.
- Fila após limpeza: 175 itens ativos.
- Itens restantes do lote após limpeza: 0.
- Leases expirados: 0.
- Retentativas vencidas: 0.
- Publicações overdue: 0.
- Health operacional após o teste: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.

Conclusão: o caminho de criação/limpeza de carga futura e as agregações operacionais suportaram o primeiro degrau de 240 itens sem deixar resíduo e sem acionar publicação real. O próximo degrau seguro é 2.400 itens futuros, ainda sem simulação de claim.

### Degraus adicionais do mesmo dia

Também foram executados dois degraus adicionais com os perfis reais disponíveis na organização:

1. `phase8-safe-smoke-2400-001`
   - Parâmetros solicitados: 100 perfis × 24 itens.
   - Perfis disponíveis usados: 17.
   - Total real criado: 408 itens futuros.
   - Inserção: 408 itens em 907 ms, aproximadamente 408 itens/s.
   - Fila antes: 175 itens ativos.
   - Fila durante: 583 itens ativos.
   - Fila após limpeza: 175 itens ativos.
   - Itens restantes após limpeza: 0.
   - Health após teste: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.

2. `phase8-safe-smoke-2400-equivalent-001`
   - Como havia 17 perfis disponíveis, o equivalente de ~2.400 itens foi feito com 17 perfis × 142 itens.
   - Total criado: 2.414 itens futuros.
   - Inserção: 2.414 itens em 2.525 ms, aproximadamente 956 itens/s.
   - Fila antes: 175 itens ativos.
   - Fila durante: 2.589 itens ativos.
   - Fila após limpeza: 175 itens ativos.
   - Itens restantes após limpeza: 0.
   - Health após teste: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.

Conclusão atual da Fase 8: o banco e as agregações operacionais suportaram inserção/limpeza de ~2.400 publicações futuras em produção sem resíduos e sem impacto crítico nos workers. O próximo degrau seguro é testar 7.200 itens futuros, ainda sem claim, ou preparar staging para simular claim/conclusão sem provedores reais.

### Degraus sintéticos isolados

Após criar `scripts/load-test/synthetic-scale-smoke.mjs`, foram validados degraus com organizações e perfis sintéticos removidos automaticamente ao final:

1. `phase8-synthetic-small-002`
   - Organizações sintéticas: 1.
   - Perfis sintéticos: 10.
   - Itens por perfil: 24.
   - Total criado: 240 itens futuros.
   - Tempo total: 1.268 ms, aproximadamente 189 itens/s.
   - Fila antes: 175 itens ativos.
   - Fila durante: 415 itens ativos.
   - Fila após limpeza: 175 itens ativos.
   - Organizações sintéticas restantes: 0.
   - Health após limpeza: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.

2. `phase8-synthetic-100x24-001`
   - Organizações sintéticas: 1.
   - Perfis sintéticos: 100.
   - Itens por perfil: 24.
   - Total criado: 2.400 itens futuros.
   - Tempo total: 2.991 ms, aproximadamente 802 itens/s.
   - Fila antes: 175 itens ativos.
   - Fila durante: 2.575 itens ativos.
   - Fila após limpeza: 175 itens ativos.
   - Organizações sintéticas restantes: 0.
   - Health após limpeza: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.

3. `phase8-synthetic-300x24-001`
   - Organizações sintéticas: 1.
   - Perfis sintéticos: 300.
   - Itens por perfil: 24.
   - Total criado: 7.200 itens futuros.
   - Tempo total: 5.925 ms, aproximadamente 1.215 itens/s.
   - Fila antes: 175 itens ativos.
   - Fila durante: 7.375 itens ativos.
   - Fila após limpeza: 175 itens ativos.
   - Organizações sintéticas restantes: 0.
   - Health após limpeza: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.

Conclusão intermediária: os degraus de cardinalidade por organização, incluindo 300 perfis e 7.200 publicações futuras, foram validados sem deixar resíduos e sem sinais críticos.

4. `phase8-synthetic-10x300x24-001`
   - Organizações sintéticas: 10.
   - Perfis sintéticos por organização: 300.
   - Itens por perfil: 24.
   - Total criado: 72.000 itens futuros.
   - Tempo total: 89.213 ms, aproximadamente 807 itens/s.
   - Fila antes: 175 itens ativos.
   - Fila durante: 72.175 itens ativos.
   - Fila após limpeza: 175 itens ativos.
   - Organizações sintéticas restantes: 0.
   - Health após limpeza: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.
   - Leases expirados: 0.
   - Retentativas vencidas: 0.
   - Publicações overdue: 0.

Conclusão da etapa de carga futura da Fase 8: o cenário-alvo de 10 organizações × 300 perfis × 24 publicações futuras, totalizando 72.000 itens, foi validado com dados sintéticos isolados e limpeza automática completa. O que ainda precisa de ambiente controlado é simular claim/conclusão concorrente e recuperação de leases sem tocar provedores reais.

### Smoke de claim e conclusão simulada

Para validar a mecânica real de reivindicação e conclusão sem chamadas a provedores, use o script sintético de claim. Ele cria uma organização isolada, perfis sintéticos e itens `ready`; depois usa as RPCs reais de claim e conclusão para marcar os itens como publicados, sem chamar Meta/Zernio:

```bash
LOAD_TEST_ID=phase8-synthetic-claim-240-001 \
LOAD_TEST_SYNTHETIC_PROFILES_PER_ORG=10 \
LOAD_TEST_POSTS_PER_PROFILE=24 \
LOAD_TEST_TOTAL_ITEM_LIMIT=1000 \
LOAD_TEST_CLAIM_LIMIT=50 \
LOAD_TEST_MAX_CYCLES=20 \
npm run load-test:synthetic-claim
```

Cuidados operacionais:

- Para evitar disputa com o worker real da VPS durante esta simulação, pausar temporariamente `athena-publication-worker` no PM2 e religá-lo após o teste.
- O script usa perfis sintéticos, não vincula mídias e não aciona APIs de provedores.
- A organização sintética é apagada ao final, removendo perfis, batch, itens e eventos por cascata.

Resultado validado em 2026-08-11 com `phase8-synthetic-claim-240-008`:

- Perfis sintéticos: 10.
- Itens prontos: 240.
- Limite de claim por ciclo: 50.
- Ciclos executados: 5.
- Itens reivindicados: 240.
- Itens concluídos como publicados: 240.
- Falhas: 0.
- Vazão simulada: aproximadamente 347 conclusões/minuto.
- Fila antes: 175 itens ativos.
- Fila após inserir itens sintéticos: 415 itens ativos.
- Fila após simulação: 175 itens ativos.
- Fila após cleanup: 175 itens ativos.
- Organizações sintéticas restantes: 0.
- Health após cleanup: HTTP 200, `critical=0`, 3 workers ativos, 0 stale, 0 erros.
- PM2 foi restaurado com `athena-publication-worker`, `athena-generation-worker` e `athena-media-maintenance-worker` online, e o dump foi salvo.

Conclusão: a etapa de claim/conclusão simulada validou as RPCs reais de fila em ambiente sintético isolado, sem provedores reais e sem resíduos. Para completar os cenários mais agressivos da Fase 8, o próximo passo é repetir claim/conclusão com múltiplos simuladores concorrentes em staging.

## 8. Planos compactos rotativos — Fase 10

Execute estes cenários somente em staging isolado. A origem `Sem grupo` precisa
conter exatamente 40 mídias elegíveis e os perfis devem ser sintéticos/online.
O script usa um JWT curto de uma sessão `admin`/`operator`; a chave
`service_role` é usada apenas no preflight e nunca substitui `auth.uid()` na
criação do plano.

Variáveis obrigatórias:

```bash
LOAD_TEST_ID=bulk-300x24-001
LOAD_TEST_ORGANIZATION_ID=uuid-da-organizacao-sintetica
BULK_LOAD_SCENARIO=300x24
BULK_LOAD_ADMIN_ACCESS_TOKEN=jwt-curto-da-sessao-controlada
BULK_LOAD_ALLOW_MUTATION=true
BULK_PUBLICATION_ROLLOUT=admins
```

Degraus disponíveis:

| Cenário | Perfis | Slots/perfil | Mídias | Publicações esperadas |
|---|---:|---:|---:|---:|
| `300x24` | 300 | 24 | 40 | 7.200 |
| `500x24` | 500 | 24 | 40 | 12.000 |
| `500x72` | 500 | 72 | 40 | 36.000 |

Primeiro valide o payload sem mutação e depois crie o plano:

```bash
npm run load-test:bulk-scenarios
npm run load-test:bulk-scenarios -- --execute --keep
```

Durante a geração, capture o relatório em intervalos regulares:

```bash
npm run load-test:bulk-report
```

O relatório mede tempo da consulta, planos ativos, backlog restante, chunks,
leases expirados e linhas em planos/perfis/snapshots/chunks/itens materializados.
Para CI ou smoke operacional falhar em alertas críticos:

```bash
BULK_FAIL_ON_CRITICAL=true npm run load-test:bulk-report
```

### Suspensão parcial

1. Inicie o plano com o generation worker ativo.
2. Depois de materializar ao menos um chunk, altere apenas um perfil sintético
   para `offline` pelo fluxo operacional normal.
3. Confirme no relatório/progresso que o chunk desse perfil ficou `paused`,
   sem aumentar retries, enquanto os demais continuam.
4. Volte o perfil a `online` e confirme que não existe retomada automática.
5. Use a retomada manual do par lote/perfil e valide que slots vencidos foram
   encerrados e o restante redistribuído após a base segura.

### Reinício controlado dos workers

No host PM2, reinicie um worker por vez. Não reinicie generation e publication
simultaneamente:

```bash
pm2 restart athena-generation-worker --update-env
npm run load-test:bulk-report
pm2 restart athena-publication-worker --update-env
npm run load-test:bulk-report
```

Aceite do reinício:

- nenhum item duplicado;
- lease anterior recuperado após expiração;
- progresso monotônico após a retomada;
- nenhum incremento de retry por suspensão offline;
- zero alerta crítico ao estabilizar.

### Rollout e rollback

Sequência recomendada:

1. `BULK_PUBLICATION_ROLLOUT=admins` e geração compacta habilitada;
2. validar um lote pequeno e os três degraus em staging;
3. promover para `managers`;
4. promover para `all` após uma janela estável.

Rollback de criação, sem apagar dados:

```bash
BULK_PUBLICATION_ROLLOUT=off
```

Isso oculta a interface e bloqueia review/confirm no servidor. Para também
parar novos claims compactos sem apagar planos/chunks/itens já existentes:

```bash
PUBLICATION_GENERATION_WORKER_BULK_ENABLED=false
```

Após mudar a variável do worker, reinicie somente
`athena-generation-worker --update-env`. O publication worker pode continuar
consumindo itens já materializados. Reabilitar claims não recria nem duplica o
plano: a geração retoma a partir de `next_slot_index` e chaves idempotentes.

### Limpeza

Finalize/cancele todos os planos do identificador, pause claims compactos e só
então execute:

```bash
BULK_LOAD_ALLOW_CLEANUP=true npm run load-test:bulk-cleanup -- --execute
```

A limpeza apaga primeiro o plano compacto (cascata de perfis, snapshots,
horizontes e chunks) e depois o lote (cascata de itens), respeitando a FK
`ON DELETE RESTRICT`. Reexecute com o mesmo `LOAD_TEST_ID` se houver falha entre
as duas exclusões.
