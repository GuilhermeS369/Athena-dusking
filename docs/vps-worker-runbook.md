# Runbook — worker de publicação na VPS

Este runbook prepara a VPS para iniciar em modo seguro de observação. Nesta etapa, o worker não publica no Instagram por padrão.

## 0. Acesso SSH correto a partir do Windows

O objetivo é permitir que o computador local conecte na VPS sem digitar senha, usando uma chave privada local e uma chave pública instalada no arquivo `/root/.ssh/authorized_keys` da VPS.

### 0.1. No Windows CMD ou PowerShell

Execute no seu computador:

```powershell
ssh-keygen -t ed25519 -f C:\Users\guilh\.ssh\athena_vps_worker_ed25519 -N "" -C "athena-vps-worker"
type C:\Users\guilh\.ssh\athena_vps_worker_ed25519.pub
```

Copie a linha inteira que começa com `ssh-ed25519`. Exemplo da chave criada para este acesso:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICjni3P9uQ4SdGQgycViUlJcEsJp4od5h3U+rK9zVhgg athena-vps-worker
```

### 0.2. No Terminal da Hostinger

Entre na VPS pelo terminal da Hostinger ou por SSH com senha. Depois rode:

```bash
mkdir -p /root/.ssh
chmod 700 /root/.ssh
grep -qxF 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICjni3P9uQ4SdGQgycViUlJcEsJp4od5h3U+rK9zVhgg athena-vps-worker' /root/.ssh/authorized_keys 2>/dev/null || echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICjni3P9uQ4SdGQgycViUlJcEsJp4od5h3U+rK9zVhgg athena-vps-worker' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
chown -R root:root /root/.ssh
tail -n 5 /root/.ssh/authorized_keys
```

### 0.3. Teste no Windows CMD ou PowerShell

Depois de instalar a chave pública na VPS, teste no seu computador:

```powershell
ssh -i C:\Users\guilh\.ssh\athena_vps_worker_ed25519 root@179.198.110.201 "echo SSH_OK && hostname && whoami"
```

O retorno esperado:

```text
SSH_OK
srv1881733
root
```

Se esse teste passar, o acesso automático está pronto.

### 0.4. Importante sobre senhas expostas

Depois que a chave SSH funcionar, troque as senhas root que foram compartilhadas. O acesso por chave é mais seguro do que manter senha root exposta.

## 1. Preparação inicial da VPS

```bash
apt update && apt upgrade -y
apt install -y curl git ufw ca-certificates build-essential htop
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
ufw allow OpenSSH
ufw --force enable
node -v
npm -v
pm2 -v
```

## 2. Deploy do projeto

```bash
mkdir -p /opt/athena-worker
cd /opt/athena-worker
git clone REPOSITORIO_DO_PROJETO .
npm ci
npm run build
```

## 3. Variáveis de ambiente

Crie o arquivo de ambiente:

```bash
nano /opt/athena-worker/.env.worker
```

Conteúdo mínimo:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role
PUBLICATION_WORKER_SECRET=seu-segredo-do-worker
PUBLICATION_WORKER_ID=athena-vps-publication-1
PUBLICATION_WORKER_MODE=observe
PUBLICATION_WORKER_DRY_RUN=true
PUBLICATION_WORKER_POLL_INTERVAL_MS=5000
PUBLICATION_WORKER_HEARTBEAT_INTERVAL_MS=60000
PUBLICATION_WORKER_LIMIT=5
PUBLICATION_WORKER_LEASE_SECONDS=180
PUBLICATION_WORKER_META_CONCURRENCY=5
PUBLICATION_WORKER_APP_BASE_URL=https://seu-app.vercel.app
```

## 4. Execução de diagnóstico uma vez

```bash
cd /opt/athena-worker
npm run worker:publication:once
```

## 5. Execução contínua com PM2

```bash
cd /opt/athena-worker
pm2 start npm --name athena-publication-worker -- run worker:publication
pm2 save
pm2 startup
pm2 status
pm2 logs athena-publication-worker
```

## 6. Monitoramento da VPS

```bash
htop
free -h
df -h
uptime
pm2 monit
```

## 7. Modos do worker

- `observe`: somente consulta a fila e registra heartbeat.
- `dispatch-endpoint`: modo transitório legado que chama o endpoint interno da aplicação. Não deve ser usado como primário depois da regra VPS-first, porque a execução real acontece na função da Vercel.
- `direct`: processa a fila diretamente na VPS usando Supabase, Storage, Meta e Zernio, sem depender do endpoint da Vercel.

O modo padrão seguro é `observe` com `PUBLICATION_WORKER_DRY_RUN=true`.

O modo `direct` também respeita `PUBLICATION_WORKER_DRY_RUN=true`: enquanto essa variável estiver `true`, ele apenas observa e não faz claim nem publica.

Não derive `PUBLICATION_WORKER_LIMIT` de um exemplo de quantidade de perfis em um slot. O valor é uma configuração de capacidade que deve ser ajustada gradualmente com base em telemetria real: duração de ciclos, atraso da fila, limites por provedor/conexão e taxa de erro. Slots coletivos em risco são retidos para recuperação coordenada; eles não devem ser compensados elevando indiscriminadamente o paralelismo do processo.

## 8. Corte seguro

1. Rodar em `observe`.
2. Confirmar heartbeat no banco.
3. Confirmar health check agregado.
4. Rodar `dispatch-endpoint` com `PUBLICATION_WORKER_LIMIT=1` somente depois de validar segredos e ambiente.
5. Validar `direct` com `PUBLICATION_WORKER_DRY_RUN=true`, confirmando que ele continua apenas observando.
6. Para ativação real controlada, alterar para `PUBLICATION_WORKER_MODE=direct`, `PUBLICATION_WORKER_DRY_RUN=false` e `PUBLICATION_WORKER_LIMIT=1`.
7. Manter cron da Vercel apenas como fallback real: o endpoint só reivindica itens quando não houver heartbeat recente de worker primário `direct`/`direct-dispatch`, `dry_run=false`, com prefixo `athena-vps-`.
8. Aumentar limite gradualmente após medir throughput, falhas, leases expirados e atraso máximo.

### Status atual do corte

Em 2026-08-11, a VPS foi colocada no primeiro estágio real controlado:

```bash
PUBLICATION_WORKER_MODE=direct
PUBLICATION_WORKER_DRY_RUN=false
PUBLICATION_WORKER_LIMIT=1
PUBLICATION_WORKER_LEASE_SECONDS=180
```

Validações feitas no corte:

- PM2 online com um único processo `athena-publication-worker` ativo.
- Heartbeat no banco com `status=dispatching`, `dry_run=false`, `mode=direct` e `dispatchLimit=1`.
- Auditoria prévia indicou zero candidatos imediatamente publicáveis no momento do corte.
- Primeiros ciclos do worker direto executaram com `claimed=0`, sem leases presos e sem itens em `preparing` ou `publishing`.
- Cron da Vercel permanece como fallback operacional, mas deve pular o processamento enquanto `athena-vps-publication-1` estiver ativo em `direct` e `dry_run=false`.

### Regra VPS-first para publicações imediatas

Desde esta correção, `POST /api/publications` apenas enfileira publicações imediatas; ele não chama mais o dispatcher dentro da requisição web. Isso remove a corrida em que a função da Vercel poderia reivindicar uma postagem antes do worker da VPS.

O endpoint `/api/internal/publication-dispatch`, usado pelo cron da Vercel, consulta `publication_worker_heartbeats` antes de processar. Se existir heartbeat recente de um worker de publicação primário com:

- `worker_id` começando por `athena-vps-` por padrão;
- `metadata.mode` igual a `direct` ou `direct-dispatch`;
- `dry_run=false`;
- `status` em `starting`, `idle`, `dispatching` ou `processing`;
- `last_seen_at` dentro de `PUBLICATION_DISPATCH_FALLBACK_STALE_SECONDS` segundos, padrão `120`;

então a Vercel retorna `skipped=true`, `reason=vps_publication_worker_active` e não reivindica nenhum item. Ela só vira fallback real quando esse heartbeat fica stale/ausente ou quando o worker não está em modo publicador direto.

O limite deve continuar em `1` até haver publicações reais processadas sem duplicidade, sem falhas inesperadas e sem crescimento de backlog.

## 9. Deploy por pacote quando não houver Git no diretório local

No computador local, gere o pacote sem dependências e artefatos pesados:

```powershell
tar --exclude='./node_modules' --exclude='./.next' --exclude='./athena-worker-deploy.tar.gz' --exclude='./.git' -czf .\athena-worker-deploy.tar.gz .
scp -i C:\Users\guilh\.ssh\athena_vps_worker_ed25519 .\athena-worker-deploy.tar.gz root@179.198.110.201:/tmp/athena-worker-deploy.tar.gz
```

Na VPS, publique preservando o `.env.worker` existente:

```bash
pm2 stop athena-publication-worker || true
cp /opt/athena-worker/.env.worker /tmp/.env.worker.current
rm -rf /opt/athena-worker-next
mkdir -p /opt/athena-worker-next
tar -xzf /tmp/athena-worker-deploy.tar.gz -C /opt/athena-worker-next
mv /tmp/.env.worker.current /opt/athena-worker-next/.env.worker
cd /opt/athena-worker-next
npm ci --omit=dev
node --check scripts/workers/publication-direct-dispatch.mjs
node --check scripts/workers/publication-worker.mjs
rm -rf /opt/athena-worker-previous
mv /opt/athena-worker /opt/athena-worker-previous
mv /opt/athena-worker-next /opt/athena-worker
cd /opt/athena-worker
npm run worker:publication:once
pm2 start npm --name athena-publication-worker -- run worker:publication
pm2 save
pm2 status
```

## 10. Worker direto de analytics de perfis

O worker `athena-profile-analytics-direct-worker` executa o coletor de analytics diretamente na VPS. O modo seguro é desligado/observação; o modo direto exige uma lista explícita de organizações e inicia com limite e concorrência iguais a 1.

Variáveis:

```bash
PROFILE_ANALYTICS_DIRECT_WORKER_ID=athena-vps-profile-analytics-direct-1
PROFILE_ANALYTICS_DIRECT_ENABLED=false
PROFILE_ANALYTICS_DIRECT_ORGANIZATION_IDS=uuid-da-organizacao-canario
PROFILE_ANALYTICS_DIRECT_LIMIT=1
PROFILE_ANALYTICS_DIRECT_CONCURRENCY=1
PROFILE_ANALYTICS_DIRECT_LEASE_SECONDS=300
PROFILE_ANALYTICS_DIRECT_POLL_INTERVAL_MS=10000
PROFILE_ANALYTICS_DIRECT_HEARTBEAT_INTERVAL_MS=60000
```

Comandos:

```bash
cd /opt/athena-worker-phase-e
npm run worker:profile-analytics:direct:once
pm2 start npm --name athena-profile-analytics-direct-worker -- run worker:profile-analytics:direct
pm2 save
```

Proteção contra execução dupla:

- o heartbeat informa `executionMode=direct` e os UUIDs de `organizationIds`;
- a rota Vercel exclui do claim somente as organizações cobertas por heartbeat direto recente;
- as organizações não cobertas continuam sendo processadas pela Vercel;
- se o heartbeat ficar ausente por 120 segundos, a Vercel volta a reivindicar a organização automaticamente;
- o claim direto é filtrado no PostgreSQL pela lista explícita de organizações.

Rollback imediato:

```bash
sed -i 's/^PROFILE_ANALYTICS_DIRECT_ENABLED=.*/PROFILE_ANALYTICS_DIRECT_ENABLED=false/' /opt/athena-worker-phase-e/.env.worker
pm2 restart athena-profile-analytics-direct-worker --update-env
pm2 save
```

Também é possível executar `pm2 stop athena-profile-analytics-direct-worker`; após a janela de heartbeat stale, o dispatcher Vercel reassume automaticamente. Não apague leases manualmente: os leases vencidos são recuperáveis pela fila.

Status em 22/08/2026: canário direto ativo apenas para a organização Vini, com limite 1, concorrência 1 e nenhum backlog elegível no momento da ativação. O processo PM2 e o heartbeat foram validados, a Vercel confirmou a exclusão seletiva somente dessa organização e as demais permaneceram no fallback. A ampliação depende de pelo menos 24 horas sem duplicidade, lease órfão ou aumento de erros.

## 11. Worker de sincronia Zernio

A sincronia mestre de contas Zernio é processada diretamente pela VPS. O botão **Sincronia de contas** apenas cria um lote durável no banco; a interface consulta o progresso por chave a cada três segundos. A VPS decripta chaves somente em memória e nunca as imprime.

Inclua estas variáveis em `/opt/athena-worker/.env.worker`:

```bash
ZERNIO_SYNC_WORKER_ID=athena-vps-zernio-sync-1
ZERNIO_SYNC_WORKER_POLL_INTERVAL_MS=10000
ZERNIO_SYNC_WORKER_LIMIT=2
ZERNIO_SYNC_WORKER_LEASE_SECONDS=180
ZERNIO_SYNC_WORKER_HEARTBEAT_INTERVAL_MS=60000
ZERNIO_API_BASE_URL=https://zernio.com/api
TOKEN_ENCRYPTION_KEY=mesma-chave-base64-do-Athena
```

Validação única, depois de aplicar as migrations de sincronia:

```bash
cd /opt/athena-worker
npm run worker:zernio-sync:once
```

Execução contínua via PM2:

```bash
cd /opt/athena-worker
pm2 start npm --name athena-zernio-sync-worker -- run worker:zernio-sync
pm2 save
pm2 logs athena-zernio-sync-worker
```

Comece com `ZERNIO_SYNC_WORKER_LIMIT=2`. Aumente somente após acompanhar tempo de ciclo, respostas de limite da Zernio, número de retries e ausência de atraso crítico nas publicações. Leases vencidos são retomáveis: outro ciclo pode reivindicar o item sem reiniciar o lote inteiro.

## 11. Worker de geração de agendamentos grandes

A Fase 2 adiciona um worker separado para geração assíncrona de grandes planos de publicação. Ele não substitui imediatamente o fluxo atual de criação em lote; primeiro cria a infraestrutura de jobs, endpoints de acompanhamento e um worker seguro para observação.

Variáveis iniciais recomendadas:

```bash
PUBLICATION_GENERATION_WORKER_ID=athena-vps-generation-1
PUBLICATION_GENERATION_WORKER_MODE=observe
PUBLICATION_GENERATION_WORKER_DRY_RUN=true
PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS=10000
PUBLICATION_GENERATION_WORKER_HEARTBEAT_INTERVAL_MS=60000
PUBLICATION_GENERATION_WORKER_LIMIT=1
PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1
PUBLICATION_GENERATION_WORKER_LEASE_SECONDS=300
PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT=1
PUBLICATION_GENERATION_WORKER_BULK_STEP_SIZE=50
PUBLICATION_GENERATION_WORKER_BULK_MAX_FAILURES=3
```

Validação local ou na VPS:

```bash
cd /opt/athena-worker
npm run worker:publication-generation:once
```

Processo contínuo quando a migration correspondente já estiver aplicada:

```bash
cd /opt/athena-worker
pm2 start npm --name athena-generation-worker -- run worker:publication-generation
pm2 save
pm2 status
pm2 logs athena-generation-worker --lines 80
```

O modo inicial seguro é `observe` com `PUBLICATION_GENERATION_WORKER_DRY_RUN=true`. O modo `plan` materializa jobs em chunks e processa no máximo os limites configurados por ciclo. Para teste conservador, usar `PUBLICATION_GENERATION_WORKER_LIMIT=1` e `PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1`.

Existe também o modo `plan-paused`, que reivindica o job e o pausa com metadados de estimativa sem materializar itens.

### Status atual do worker de geração

Em 2026-08-11, após aplicação da migration `059_publication_generation_jobs.sql`, a VPS recebeu o pacote atualizado e passou a rodar dois processos no PM2:

- `athena-publication-worker`: publicação direta, `PUBLICATION_WORKER_MODE=direct`, `PUBLICATION_WORKER_DRY_RUN=false`, `PUBLICATION_WORKER_LIMIT=1`.
- `athena-generation-worker`: geração de agendamentos grandes, `PUBLICATION_GENERATION_WORKER_MODE=observe`, `PUBLICATION_GENERATION_WORKER_DRY_RUN=true`, `PUBLICATION_GENERATION_WORKER_LIMIT=1`.

Validações feitas:

- Tabelas `publication_generation_jobs`, `publication_generation_job_chunks` e `publication_generation_job_events` existem em produção.
- Worker de geração executou uma vez com sucesso e encontrou zero jobs pendentes.
- PM2 confirmou os dois processos online.
- Heartbeats confirmados para `athena-vps-publication-1` e `athena-vps-generation-1`.
- Logs sem erro nos dois workers.

Próximo passo técnico: implementar expansão idempotente real dos jobs em chunks, ainda sem alterar a tela para liberar mais de 500 itens até o fluxo de geração estar validado.

### Status da expansão idempotente em chunks

Em 2026-08-11, a migration `060_publication_generation_chunk_processing.sql` foi aplicada em produção e o pacote atualizado foi implantado na VPS.

O que ficou pronto:

- `publication_generation_jobs.batch_id` liga cada job a um lote real de publicações.
- `materialize_publication_generation_job` cria o lote uma única vez e divide `payload.items` em chunks idempotentes.
- `claim_publication_generation_job_chunks` permite reivindicar chunks com lease e `skip locked`.
- `process_publication_generation_chunk` insere `publication_items` e `publication_item_media` com idempotência por `idempotencyKey`.
- O worker `athena-generation-worker` já conhece os modos `observe`, `plan-paused` e `plan`.
- A VPS permanece segura com `PUBLICATION_GENERATION_WORKER_MODE=observe` e `PUBLICATION_GENERATION_WORKER_DRY_RUN=true`.

Validações feitas:

- Build local passou após a migration e alteração do worker.
- RPCs novos foram detectados em produção.
- PM2 confirmou `athena-publication-worker` e `athena-generation-worker` online.
- Heartbeat do worker de geração segue `observing`, `dry_run=true`, sem jobs/chunks pendentes.

Próximo passo seguro: criar um job pequeno de teste com payload real e rodar `PUBLICATION_GENERATION_WORKER_MODE=plan` com `PUBLICATION_GENERATION_WORKER_LIMIT=1` e `PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1`, monitorando se o batch e os itens são criados corretamente.

### Validação prática da geração em chunks

Em 2026-08-11, foi executado um smoke test real e seguro da geração em chunks:

- Criado um job pequeno com 1 item futuro usando um perfil e uma mídia prontos da organização.
- Executado `athena-generation-worker` uma única vez com `PUBLICATION_GENERATION_WORKER_MODE=plan`, `PUBLICATION_GENERATION_WORKER_DRY_RUN=false`, `PUBLICATION_GENERATION_WORKER_LIMIT=1` e `PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1`.
- A primeira execução encontrou ambiguidade SQL em `chunk_index`; a correção foi aplicada pela migration `061_fix_generation_materialize_chunk_index_ambiguity.sql`.
- Após a correção, o worker materializou o job, criou um batch, criou 1 chunk, criou 1 `publication_items` futuro e vinculou 1 mídia em `publication_item_media`.
- O job terminou como `completed`, com `generated_items=1`, `failed_items=0` e `chunk_count=1`.
- O lote, o job, o chunk e o item de teste foram removidos ao final para não deixar agendamento artificial.
- Após a limpeza, a fila voltou ao estado anterior, sem jobs/chunks de geração pendentes e sem itens de smoke test.
- PM2 confirmou `athena-publication-worker` e `athena-generation-worker` online.
- O worker de geração voltou a operar em `observe`/`dry_run=true`.

Resultado: a expansão idempotente em chunks foi validada ponta a ponta com 1 item futuro. A etapa seguinte conectou esse caminho a uma criação controlada pela API/UI, ainda mantendo limites conservadores.

### Integração da criação grande pela API/UI

Em 2026-08-11, a criação grande de publicações foi conectada ao fluxo assíncrono:

- `app/api/publications/route.ts` mantém a criação síncrona para até 500 publicações expandidas.
- Acima de 500 publicações expandidas, a rota cria um registro em `publication_generation_jobs` via `create_publication_generation_job` e retorna HTTP 202.
- O job recebe `payload.items` já validado, expandido por perfil e com chaves de idempotência, usando chunks de 500.
- `app/postagem/publishing-client.tsx` aceita a resposta assíncrona, limpa o formulário e informa que o agendamento grande foi enviado para processamento.
- Build local passou com `npm run build`; os únicos avisos foram os já existentes de metadata `viewport`/`themeColor`.

Limites conservadores desta integração:

- Até 500 publicações expandidas: criação síncrona tradicional em `publication_batches`/`publication_items`.
- Mais de 500 publicações expandidas: criação de job assíncrono.
- Até 5.000 itens-base por requisição na API.
- Até 50.000 publicações expandidas por job criado por esta rota.

Operação segura após deploy:

- Manter `athena-generation-worker` em `PUBLICATION_GENERATION_WORKER_MODE=observe` e `PUBLICATION_GENERATION_WORKER_DRY_RUN=true` durante o deploy da UI/API.
- Depois do deploy, criar um job grande controlado e alternar temporariamente para `PUBLICATION_GENERATION_WORKER_MODE=plan`, `PUBLICATION_GENERATION_WORKER_DRY_RUN=false`, `PUBLICATION_GENERATION_WORKER_LIMIT=1` e `PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1`.
- Confirmar que o job cria o batch, os chunks e os itens corretamente antes de deixar o worker de geração em modo `plan` contínuo.

### Validação grande controlada pós-deploy

Em 2026-08-11, após deploy da Vercel, foi validado o caminho assíncrono com um smoke test operacional acima do limite síncrono:

- O endpoint público `/api/publications` respondeu 401 sem sessão, confirmando proteção de autenticação.
- PM2 mostrou `athena-publication-worker` e `athena-generation-worker` online.
- A configuração persistente do worker de geração permaneceu segura: `PUBLICATION_GENERATION_WORKER_MODE=observe`, `PUBLICATION_GENERATION_WORKER_DRY_RUN=true`, `PUBLICATION_GENERATION_WORKER_LIMIT=1` e `PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1`.
- Criado script operacional `scripts/workers/smoke-large-generation-job.mjs` para criar, inspecionar e limpar jobs grandes de teste direto no Supabase com service role.
- Criado job de smoke com 501 publicações futuras e `chunk_size=500`.
- Executado o worker manualmente na VPS em `PUBLICATION_GENERATION_WORKER_MODE=plan`, `PUBLICATION_GENERATION_WORKER_DRY_RUN=false`, `PUBLICATION_GENERATION_WORKER_LIMIT=1` e `PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1`.
- A primeira execução materializou o job em 2 chunks e gerou 500 itens.
- A segunda execução processou o chunk restante e gerou mais 1 item.
- Resultado validado: job `completed`, `expected_items=501`, `generated_items=501`, `failed_items=0`, `chunk_count=2`, batch criado, 501 itens criados e amostra com vínculos de mídia presentes.
- O smoke test foi limpo ao final, removendo batch/job/chunks/itens artificiais.
- O worker de geração foi confirmado novamente em `observe`/`dry_run=true`, com zero jobs pendentes.

### Corte para motor de geração assíncrona ativo

Ainda em 2026-08-11, depois do smoke test de 501 itens e da limpeza dos dados artificiais, o worker de geração foi ativado como motor contínuo conservador:

- Pré-checagem em `observe`/`dry_run=true` confirmou zero jobs pendentes.
- A configuração persistente em `/opt/athena-worker/.env.worker` foi alterada para:

```bash
PUBLICATION_GENERATION_WORKER_MODE=plan
PUBLICATION_GENERATION_WORKER_DRY_RUN=false
PUBLICATION_GENERATION_WORKER_LIMIT=1
PUBLICATION_GENERATION_WORKER_CHUNK_LIMIT=1
```

- O processo `athena-generation-worker` foi reiniciado no PM2 com `--update-env`.
- PM2 confirmou `athena-generation-worker` online.
- Logs pós-restart confirmaram `mode=plan`, `dryRun=false`, `claimedJobs=0`, `claimedChunks=0`, `processedChunks=[]` e zero jobs pendentes.
- Uma execução manual adicional em modo `plan` confirmou novamente ausência de jobs/chunks pendentes e ausência de erro.

Estado operacional atual: a criação grande pela UI/API pode criar jobs assíncronos e a VPS já processa esses jobs continuamente, mas ainda com limite conservador de 1 job e 1 chunk por ciclo. O próximo aumento deve ser gradual e baseado em observação de CPU, memória, tempo de geração, quantidade de conflitos de slots e impacto na fila de publicação.

### Geração compacta de Programar em massa

Em 2026-08-13, a migration `086_bulk_rotation_incremental_generation.sql` e o worker de geração receberam o caminho compacto, separado dos jobs tradicionais:

- `claim_bulk_rotation_generation_chunks` reivindica somente referências de chunks compactos, com lease recuperável e `FOR UPDATE SKIP LOCKED`.
- `process_bulk_rotation_generation_chunk` materializa no máximo `PUBLICATION_GENERATION_WORKER_BULK_STEP_SIZE` slots por chamada e persiste o cursor na mesma transação.
- `fail_bulk_rotation_generation_chunk` libera apenas o chunk que falhou, incrementa falhas consecutivas e esgota retries no limite configurado.
- O worker continua processando os demais chunks quando um chunk compacto falha.
- Perfis offline são pausados sem consumir retry e não voltam automaticamente ao ficarem online.
- O heartbeat inclui `summary.bulk` e `compactActivity`, com backlog agregado e o resultado do último chunk do ciclo.
- `observe` ou `dry_run=true` não executa claims compactos nem tradicionais.

Configuração conservadora inicial:

```bash
PUBLICATION_GENERATION_WORKER_MODE=plan
PUBLICATION_GENERATION_WORKER_DRY_RUN=false
PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT=1
PUBLICATION_GENERATION_WORKER_BULK_STEP_SIZE=50
PUBLICATION_GENERATION_WORKER_BULK_MAX_FAILURES=3
```

Validação da Fase 4:

- Migration validada sobre restauração limpa do schema remoto em PostgreSQL 17.
- `plpgsql_check` retornou zero erros para as quatro funções PL/pgSQL compactas.
- Teste SQL transacional cobriu lease expirado, passos limitados, rotação, replay idempotente, perfil offline e exaustão de falhas.
- Migration 086 aplicada ao Supabase remoto; histórico local/remoto alinhado até 086.
- Smoke remoto em `observe` e em `plan` sem backlog confirmou as RPCs e os resumos compactos sem criar dados artificiais.

Antes de atualizar a VPS, copiar o worker e as três novas variáveis para `/opt/athena-worker/.env.worker`, validar com `node --check scripts/workers/publication-generation-worker.mjs` e reiniciar `athena-generation-worker` com `pm2 restart athena-generation-worker --update-env`.

### Suspensão automática quando o perfil fica offline

Em 2026-08-13, as migrations `087_add_publication_suspension_states.sql` e `088_suspend_offline_profile_publications.sql` foram aplicadas ao Supabase remoto e o dispatcher direto atualizado foi implantado na VPS.

Comportamento operacional:

- a transição de um perfil para qualquer estado diferente de `online`, ou sua exclusão lógica, suspende os itens ativos/futuros e os perfis compactos ainda em geração;
- a suspensão limpa claim, lease, retry e reservas de capacidade, sem consumir tentativa adicional;
- claims e recuperação de horários perdidos exigem perfil online e ignoram itens suspensos;
- itens suspensos não contam como overdue, retry vencido, lease expirado ou atraso máximo;
- voltar o perfil para online não retoma publicações automaticamente;
- o dispatcher consulta novamente o perfil ao carregar o item e usa uma barreira transacional imediatamente antes de chamar Meta ou Zernio;
- se a confirmação externa ou um identificador de criação já tiver sido aceito durante uma corrida com a suspensão, o worker reconcilia essa verdade sem criar publicação externa duplicada;
- a fila expõe o estado `suspended`, mas não oferece retomada antes da Fase 6.

Ordem de deploy usada:

1. aplicar e confirmar as migrations 087 e 088 no banco;
2. validar a disponibilidade das RPCs com `node scripts/workers/validate-phase5-deploy.mjs`;
3. validar `scripts/workers/publication-direct-dispatch.mjs` com `node --check`;
4. criar backup do dispatcher anterior;
5. instalar o novo dispatcher e reiniciar `athena-publication-worker` com `--update-env`;
6. salvar o estado do PM2 e observar ciclos e crescimento do arquivo de erro.

Validação da Fase 5:

- teste SQL funcional e teste de escala com 2.000 itens aprovados em PostgreSQL 17;
- zero achados no `plpgsql_check` das funções regulares e da função de trigger;
- histórico de migrations local/remoto alinhado até 088;
- smoke remoto confirmou o resumo operacional e as três RPCs de barreira/reconciliação no cache do PostgREST;
- `node --check` passou antes e depois da instalação na VPS;
- backup criado em `/opt/athena-worker/scripts/workers/publication-direct-dispatch.mjs.phase4-backup`;
- os quatro processos permaneceram online no PM2;
- ciclos pós-restart registraram `claimed=0`, `expiredLeases=0`, `dueRetries=0` e `overdue=0`;
- o arquivo de erro não cresceu durante a janela de observação pós-restart. A ocorrência Cloudflare 522/PGRST002 já presente no arquivo foi tratada como registro retido, sem recorrência observada nos ciclos atuais;
- health consolidado confirmou quatro workers ativos, zero stale, zero workers em erro e zero problemas críticos. O estado `degraded` permaneceu por avisos operacionais preexistentes, não por falha do worker implantado.

Não existe retomada automática ou manual nesta etapa. A retomada isolada por lote e perfil pertence à Fase 6 e deve redistribuir somente o trabalho restante, sem disparar itens vencidos.

### Retomada manual isolada por lote e perfil

Em 2026-08-13, as migrations `089_add_publication_resume_event.sql` e `090_resume_suspended_batch_profile_publications.sql` habilitaram a retomada manual da Fase 6.

Regras operacionais:

- o perfil precisa estar `online`; apenas mudar seu status para online continua sem retomar nada;
- a ação opera somente sobre um par lote/perfil e mantém os demais lotes do perfil suspensos;
- horários vencidos são encerrados como `ignored`, sem tentativa de publicação atrasada;
- publicações restantes são redistribuídas depois da maior base entre agora, fila concorrente e horizonte compacto concorrente;
- o primeiro novo horário é sempre a base segura mais o intervalo;
- planos compactos preservam o índice original dos slots e, portanto, a posição correta na rotação de mídia;
- a operação é serializada com criação de planos e suspensão do perfil para impedir conflito de horizonte;
- cada item tratado recebe evento `resumed` e cada operação recebe um registro agregado em `profile_publication_resumptions`;
- um segundo play no mesmo par sem itens suspensos é rejeitado, em vez de duplicar trabalho.

A interface chama `POST /api/publications/batch/[batchId]/profiles/[profileId]/resume`. Administradores e operadores visualizam a ação somente nos itens suspensos; o botão fica bloqueado enquanto o perfil não estiver online.

Validação executada:

- teste tradicional confirmou rejeição offline, ausência de retomada automática, encerramento de vencidos, redistribuição futura, isolamento de outro lote, auditoria e rejeição do segundo play;
- teste compacto confirmou pausa depois de geração parcial, encerramento dos itens materializados vencidos, preservação do cursor original e redistribuição dos slots restantes;
- restauração limpa do schema remoto e migrations 089/090 passaram em PostgreSQL 17;
- migrations aplicadas ao Supabase remoto, com histórico local/remoto alinhado até 090;
- smoke remoto confirmou a RPC no cache do PostgREST sem alterar dados reais;
- TypeScript, 46 testes da aplicação e build de produção passaram.

Esta fase não exige alteração dos workers da VPS: os workers existentes já consomem os itens e chunks que a RPC devolve para `waiting`/`queued`.

### Acompanhamento visual no painel

Em 2026-08-11, a tela de postagem recebeu acompanhamento visual dos jobs grandes:

- `app/postagem/publishing-client.tsx` consulta `GET /api/publication-generation-jobs?limit=8` na abertura da tela.
- A seção "Geração assíncrona" mostra os jobs recentes com status, percentual de progresso, itens esperados, itens gerados, itens com falha, quantidade de chunks, tamanho de chunk e erro mais recente.
- Jobs em `queued` ou `processing` ativam polling leve a cada 10 segundos para atualizar o painel e recarregar a fila.
- Quando um envio grande é criado, o cliente atualiza a lista de jobs imediatamente.
- `app/globals.css` recebeu estilos dedicados para cards, barra de progresso e métricas dos jobs.
- Build local passou com `npm run build`; permaneceram apenas avisos já conhecidos de metadata `viewport`/`themeColor`.

Com isso, o operador não depende mais apenas da fila final: ele consegue ver que um envio acima de 500 publicações foi aceito, está sendo processado em chunks e depois convertido em itens da fila.

## 11. Rate limit e justiça conservadora da publicação

A Fase 4 inicial adiciona uma camada de proteção antes da publicação final. O objetivo é impedir que um cliente, provedor ou perfil monopolize a fila quando o sistema começar a gerar grandes volumes de itens.

Arquivos envolvidos:

- `supabase/migrations/062_publication_rate_limit_fairness.sql`
- `scripts/workers/publication-direct-dispatch.mjs`

O que a migration adiciona:

- `publication_rate_limit_settings`: limites globais, por organização e por provedor.
- `publication_dispatch_rate_reservations`: reservas temporárias de capacidade durante tentativas de publicação.
- `reserve_publication_dispatch_capacity(...)`: RPC transacional chamada pelo worker antes da publicação final.

Política vigente:

```bash
max_provider_publications_per_minute=50 # Meta e fallback global
zernio_max_provider_publications_per_minute=200
max_profile_publications_per_24h=100
min_seconds_between_profile_publications=45
reservation_seconds=300
```

Os limites acumulados por organização/provedor de uma hora e de 24 horas foram
removidos pela migration
[`179_raise_zernio_minute_limit_remove_provider_cumulative_limits.sql`](../supabase/migrations/179_raise_zernio_minute_limit_remove_provider_cumulative_limits.sql).
Continuam válidos os limites por perfil e as reservas transacionais para
concorrência.

> ### ⚠️ Correção — os 200/minuto NÃO são um limite da Zernio
>
> **Verificado contra a documentação oficial em 2026-08-29** ([docs.zernio.com/guides/rate-limits](https://docs.zernio.com/guides/rate-limits)).
>
> Versões anteriores deste runbook afirmavam que *"o limite de 200/minuto é uma
> configuração global específica da Zernio"*. **Isso é falso.** O número 200 não
> aparece em lugar nenhum da documentação da Zernio, e o comentário da migration
> 179 que originou a afirmação (*"A Zernio pode despachar até 200 publicações por
> minuto por organização"*) também não tem respaldo. A própria migration grava a
> linha com `organization_id is null` — é um padrão **global do Athena**, não um
> teto do provedor.
>
> **O que a Zernio de fato limita:**
>
> | Limite | Valor | Escopo |
> |---|---|---|
> | Requisições de API | 60/min (0–2 contas) · 600/min (3–2.000) · **1.200/min (2.001+)** | **por *team*** (todas as contas do time de cobrança) |
> | Analytics | 6 a 20 req/s conforme a faixa | por *team*, separado do limite geral |
> | Velocidade de postagem | **25 posts/hora por conta** | por conta, por plataforma |
> | Instagram | **100/dia por conta** | por conta |
>
> Ao exceder: `429 Too Many Requests` com `Retry-After` e `retryAfterSeconds`.
>
> **Três consequências práticas:**
>
> 1. **A escala da Zernio é por requisição HTTP, não por publicação**, e o agrupamento
>    é por *team* — que no nosso modelo corresponde a uma **conexão/chave de API**,
>    não à organização do Athena. A Zernio não sabe que "Pomodoro" ou "Vini" existem.
> 2. **Distribuir perfis em mais organizações do Athena não aumenta orçamento
>    nenhum** na Zernio. O que distribui carga é ter mais chaves — e em 2026-08-29
>    havia **1.297 conexões com 1.102 chaves distintas**.
> 3. **`min_seconds_between_profile_publications = 45` é mais permissivo que o
>    provedor**: permite 80 posts/hora por perfil contra os 25/hora da Zernio. Não
>    é atingido pela rotação em massa (o piso de 29 min dá ~2/hora), mas um
>    agendamento avulso em rajada no mesmo perfil pode gerar `429`.
>
> O `max_profile_publications_per_24h = 100` **está correto** — coincide com o
> limite diário do Instagram na Zernio.
>
> O valor de 200 continua em produção porque é **conservador**, não porque seja o
> teto do provedor. Antes de alterá-lo, ver
> [plano de ajuste de gargalos](../plans/plano-ajuste-gargalos-reais-2026-08-29.md).

Comportamento no worker direto:

- Meta oficial: reserva capacidade só antes do `media_publish`, não durante criação/polling do contêiner.
- Zernio: reserva capacidade antes de `publishNow`, porque o envio para a Zernio já representa tentativa final de publicação.
- Quando a reserva é negada, o item volta para `waiting`, ganha `next_attempt_at`, `last_error_code` e evento `processing_deferred`.
- Quando a publicação termina ou falha, a reserva temporária é liberada pelo worker; se houver crash, ela expira automaticamente.

Ordem segura de deploy:

1. Aplicar a migration `062_publication_rate_limit_fairness.sql` no Supabase de produção.
2. Subir o pacote atualizado para a VPS.
3. Rodar `node --check scripts/workers/publication-direct-dispatch.mjs` na VPS.
4. Reiniciar `athena-publication-worker` com PM2.
5. Confirmar logs sem erro de RPC ausente.
6. Manter `PUBLICATION_WORKER_LIMIT=1` até observar publicações reais com as reservas funcionando.

Validação local executada:

- `node --check scripts/workers/publication-direct-dispatch.mjs` passou.
- `npm run build` passou; restaram apenas avisos já conhecidos de metadata `viewport`/`themeColor`.

### Deploy da Fase 4 em produção

Em 2026-08-11, a Fase 4 inicial foi aplicada em produção:

- Confirmado antes do deploy que a Fase 2 já estava operacional: geração assíncrona em chunks, worker de geração em `plan`, validação de 501 itens e painel visual na postagem.
- Confirmado que a Fase 3 já estava operacional em modo conservador: `athena-publication-worker` em `direct`, `dry_run=false`, `PUBLICATION_WORKER_LIMIT=1`.
- Aplicada a migration `062_publication_rate_limit_fairness.sql` no Supabase remoto com `npx supabase db push`.
- Pacote atualizado enviado para `/tmp/athena-worker-deploy.tar.gz` e implantado em `/opt/athena-worker`.
- `.env.worker` existente foi preservado.
- `node --check` passou na VPS para `publication-direct-dispatch.mjs`, `publication-worker.mjs`, `publication-generation-worker.mjs` e `smoke-large-generation-job.mjs`.
- `athena-publication-worker` e `athena-generation-worker` foram reiniciados no PM2; entradas antigas paradas foram removidas e o dump do PM2 foi salvo.
- Logs pós-deploy não mostraram erro.
- Validação de banco confirmou:
  - default global em `publication_rate_limit_settings` ativo;
  - `activeDispatchReservations=0`;
  - `activeGenerationJobs=0`;
  - heartbeat recente de `athena-vps-generation-1` em `processing`, `dry_run=false`, `mode=plan`;
  - heartbeat recente de `athena-vps-publication-1` em `dispatching`, `dry_run=false`, `mode=direct`;
  - fila estável com 179 itens, 176 `waiting`, 3 `failed`, zero overdue, zero due retries e zero expired leases.

Estado atual: o worker de publicação já está usando os guardrails de rate limit/fairness em produção. O aumento de `PUBLICATION_WORKER_LIMIT` deve continuar bloqueado até haver amostra real de publicações sob essa nova camada.

## 12. Cancelamento de jobs grandes

Jobs grandes podem ser cancelados pela tela de postagem enquanto estiverem em `queued`, `processing`, `paused` ou `failed`.

A ação chama `PATCH /api/publication-generation-jobs/[jobId]` com:

```json
{ "action": "cancel" }
```

No banco, a RPC `cancel_publication_generation_job` executa o cancelamento em transação:

- marca o job como `cancelled` e limpa `claimed_by`/`lease_until`;
- cancela chunks ainda não concluídos;
- cancela publicações do lote que continuam em estados canceláveis;
- libera reservas de rate limit associadas;
- preserva itens já publicados/removidos/encerrados;
- registra eventos no histórico do job e dos itens;
- ressincroniza o status do lote.

Depois de aplicar a migration `063_cancel_publication_generation_jobs.sql`, não é necessário reiniciar os workers para reconhecer o cancelamento: os claims passam a ignorar jobs/chunks com status `cancelled`.

## 13. Métricas agregadas do compositor de postagem

Em 2026-08-11, foi aplicada a migration `064_posting_composer_profile_metrics.sql`.

A RPC `get_posting_composer_profile_metrics` agrega no Postgres os dados que a tela de postagem usa para prévia e conflitos por perfil:

- total de publicações agendadas ativas por perfil;
- slots futuros ocupados por perfil;
- slots futuros ocupados por formato;
- contagens agendadas por formato;
- contagens publicadas por formato.

Com isso, `app/postagem/page.tsx` deixa de baixar todos os itens futuros/publicados da organização para montar essas métricas no servidor da Vercel. Essa é a primeira refatoração prática da Fase 5 para manter a tela de postagem viável com centenas de perfis e filas grandes.

Validações executadas:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `064_posting_composer_profile_metrics.sql` no banco remoto.

## 14. Rollups agregados da dashboard

Em 2026-08-11, foi aplicada a migration `065_dashboard_publication_rollups.sql`.

A RPC `get_dashboard_publication_rollups` agrega no Postgres os dados de publicações usados pela dashboard:

- publicações por status;
- publicações por formato;
- série diária de publicações;
- melhores janelas de dia/hora.

Com isso, `lib/dashboard/server.ts` deixa de buscar uma amostra fixa de `publication_items` e `app/dashboard-client.tsx` consome rollups agregados via `publicationRollups`. Essa mudança reduz payload e processamento no cliente quando a organização tiver filas muito grandes.

Validações executadas:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `065_dashboard_publication_rollups.sql` no banco remoto.

## 15. Agenda paginada por janela e filtros

Em 2026-08-11, a Agenda foi ajustada para não depender mais de uma amostra fixa carregada no server component.

Mudanças principais:

- `app/agenda/page.tsx` carrega apenas os perfis usados no filtro.
- `GET /api/agenda-items` busca publicações por organização autenticada com filtro por perfil, status e janela de datas.
- A paginação usa cursor composto por `execute_at` e `id`, evitando offset em filas grandes.
- `app/agenda/agenda-client.tsx` carrega a primeira página sob demanda, permite trocar a janela entre 7, 30, 90 e 180 dias e exibe “Ver mais publicações” quando houver continuação.

Validação executada:

- `npm run build` passou localmente;
- não houve migration nova nesta etapa.

## 20. Observabilidade inicial de workers e jobs assíncronos

Em 2026-08-11, foi aplicada a migration `068_worker_operational_status.sql`.

A Central Operacional passou a carregar dois resumos agregados diretamente do Postgres:

- `get_worker_operational_status`: mostra workers registrados em `publication_worker_heartbeats`, incluindo tipo, status, `dry_run`, host, PID, último heartbeat, idade do heartbeat e alerta de worker parado.
- `get_async_job_operational_summary`: resume backlog de jobs grandes de geração, exclusão de mídia e organização em grupos por status, unidades pendentes e falhas.

Impacto operacional:

- A tela `/operacao` passa a mostrar se a VPS parou de enviar heartbeat.
- Jobs assíncronos de geração, exclusão e organização em grupos entram no diagnóstico geral sem precisar listar milhares de linhas.
- Workers em erro/parados e falhas de jobs passam a somar no indicador de problemas críticos.

Validação executada:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `068_worker_operational_status.sql` no banco remoto.

## 21. Alertas automáticos da Central Operacional

Em 2026-08-11, foi aplicada a migration `069_operational_alerts.sql`.

A função `get_operational_alerts` consolida sinais críticos e avisos em uma única leitura agregada. Ela usa os resumos já existentes de fila, workers e jobs assíncronos para evitar consultas client-side em listas grandes.

Alertas cobertos:

- leases expirados na fila de publicação;
- retentativas vencidas;
- publicações atrasadas;
- atraso máximo da fila acima do limite configurado;
- workers sem heartbeat recente;
- workers em estado de erro;
- jobs assíncronos com unidades falhas;
- jobs assíncronos antigos ainda abertos.

Impacto operacional:

- `/operacao` passa a exibir um card de “Alertas” com totais críticos e avisos.
- A seção “Alertas automáticos” mostra a prioridade operacional antes das listas detalhadas.
- O contador de problemas críticos usa os alertas agregados como fonte principal para sinais de infraestrutura.

Validação executada:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `069_operational_alerts.sql` no banco remoto.

## 22. Throughput real de publicação

Em 2026-08-11, foi aplicada a migration `070_publication_throughput_summary.sql`.

A função `get_publication_throughput_summary` mede vazão real recente sem listar publicações individuais. Ela retorna janelas de 15 minutos, 1 hora, 24 horas e janela customizada, com:

- publicações concluídas;
- falhas recentes;
- tentativas totais;
- perfis únicos publicados;
- atraso médio entre horário previsto e publicação real;
- maior atraso observado na janela.

Impacto operacional:

- `/operacao` passa a mostrar a vazão por hora e por 24 horas.
- O painel ajuda a comparar o ritmo real dos workers com a meta de escala.
- A leitura é agregada no Postgres e não aumenta o custo da tela conforme o volume de publicações cresce.

Validação executada:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `070_publication_throughput_summary.sql` no banco remoto.

## 23. Health check operacional consolidado

Em 2026-08-11, foi aplicada a migration `071_global_operational_health.sql` e criado o endpoint interno `GET /api/internal/operational-health`.

A função `get_global_operational_health` consolida em uma única leitura global:

- organizações ativas;
- itens ativos de publicação;
- leases expirados;
- retentativas vencidas;
- publicações atrasadas;
- atraso máximo da fila;
- workers registrados, ativos, parados e em erro;
- jobs assíncronos abertos;
- unidades pendentes/falhas;
- throughput da última hora e das últimas 24 horas;
- sinais críticos e avisos.

O endpoint aceita os mesmos segredos operacionais já usados pelos workers:

- header `x-publication-worker-secret`;
- header `x-media-deletion-worker-secret`;
- ou `Authorization: Bearer ...`.

Exemplo de validação externa:

```bash
curl -fsS https://seu-app.vercel.app/api/internal/operational-health \
  -H "x-publication-worker-secret: seu-segredo"
```

Comportamento esperado:

- `status: ok`: sem sinais críticos ou avisos;
- `status: degraded`: há avisos, mas nenhum sinal crítico;
- `status: unhealthy`: há sinal crítico e o endpoint responde HTTP 503.

Validação executada:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `071_global_operational_health.sql` no banco remoto.

### Status pós-deploy do worker de manutenção de mídia

Em 2026-08-11, o pacote atualizado foi enviado para a VPS e o PM2 passou a manter três processos online:

- `athena-publication-worker`;
- `athena-generation-worker`;
- `athena-media-maintenance-worker`.

O worker `athena-media-maintenance-worker` executa `scripts/workers/media-maintenance-worker.mjs` e chama `/api/internal/media-deletion-dispatch`, que agora processa tanto exclusões grandes quanto jobs de organização em grupos.

Validações feitas na VPS:

- sintaxe validada com `node --check` para os scripts principais;
- `npm ci --omit=dev` concluído;
- processos antigos parados removidos do PM2;
- `pm2 save` executado;
- logs do worker de mídia confirmaram ciclos com `chunks: 0` para exclusão e `chunks: 0` para organização em grupos, sem erros.

Observação: a validação do endpoint `/api/internal/operational-health` no domínio da Vercel retornou 404 antes do próximo deploy da Vercel. Depois do deploy web, valide com:

```bash
cd /opt/athena-worker
npm run worker:operational-health
```

## 16. Central operacional paginada

Em 2026-08-11, a Central operacional recebeu paginação para as listas que podem crescer mais com o aumento da fila.

Mudanças principais:

- `GET /api/operation-attention-items` carrega publicações com atenção usando cursor por `updated_at` e `id`.
- `GET /api/operation-events` carrega logs recentes usando cursor por `created_at` e `id`.
- `app/operacao/page.tsx` entrega apenas a primeira página de 80 itens/eventos no render inicial.
- `app/operacao/operation-client.tsx` permite carregar páginas adicionais sem recarregar a tela.

Validação executada:

- `npm run build` passou localmente;
- não houve migration nova nesta etapa.

## 17. Proteção de mídias usadas por jobs grandes

Em 2026-08-11, foi aplicada a migration `066_protect_media_used_by_generation_jobs.sql`.

A proteção impede que exclusões da galeria removam mídias que ainda estão referenciadas por jobs grandes de geração ativos. Isso evita que um job pendente/processando materialize publicações futuras com arquivos já apagados.

Comportamento aplicado:

- `media_asset_is_in_active_generation_job` detecta uso da mídia em `publication_generation_jobs.payload.items` e em chunks ativos.
- `delete_media_assets_and_remove_publication_items` ignora mídias protegidas por jobs grandes ativos.
- `create_media_deletion_job` não adiciona mídias protegidas à fila assíncrona de exclusão.
- `count_gallery_media_ids` e `list_gallery_media_ids_for_deletion` também excluem mídias protegidas da seleção em massa.

Validações executadas:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `066_protect_media_used_by_generation_jobs.sql` no banco remoto.

## 18. Organização em massa de mídias em grupos

Em 2026-08-11, foi aplicada a migration `067_async_media_group_assignment_jobs.sql`.

A partir dessa etapa, ações grandes de “Organizar em grupos” na galeria deixam de depender de uma única chamada síncrona. Operações pequenas continuam imediatas; operações acima de 500 mídias ou acima de 5.000 relações mídia×grupo entram em fila assíncrona.

Componentes adicionados:

- `media_group_assignment_jobs`: cabeçalho da fila com status, ação, grupos de destino e métricas.
- `media_group_assignment_job_items`: itens por mídia, processados em chunks.
- `create_media_group_assignment_job`: cria a fila a partir da seleção da galeria.
- `claim_media_group_assignment_job`: reivindica um job com lease para worker/cron.
- `process_media_group_assignment_job_chunk`: aplica `add`, `remove` ou `replace` em blocos.
- `refresh_media_group_assignment_job_status`: recalcula progresso e finalização.
- `GET /api/media/group-assignment-jobs/[jobId]`: endpoint de acompanhamento no painel.
- `scripts/workers/media-maintenance-worker.mjs`: worker opcional para VPS chamar o dispatcher de mídia continuamente.

O endpoint existente `POST /api/media/groups/bulk` agora retorna `202 Accepted` com `job.id` quando a operação é grande. A interface da galeria acompanha o progresso e atualiza a lista ao concluir.

Validação executada:

- `npm run build` passou localmente;
- `npx supabase db push` aplicou `067_async_media_group_assignment_jobs.sql` no banco remoto.

Worker opcional na VPS:

```bash
cd /opt/athena-worker
npm run worker:media-maintenance:once
pm2 start npm --name athena-media-maintenance-worker -- run worker:media-maintenance
pm2 save
pm2 status
```

Variáveis recomendadas para manter identificação estável e heartbeat operacional:

```bash
MEDIA_MAINTENANCE_WORKER_ID=athena-vps-media-maintenance-1
MEDIA_MAINTENANCE_WORKER_POLL_INTERVAL_MS=5000
MEDIA_MAINTENANCE_WORKER_HEARTBEAT_INTERVAL_MS=60000
MEDIA_MAINTENANCE_WORKER_LEASE_SECONDS=180
MEDIA_DELETION_WORKER_LIMIT=3
MEDIA_DELETION_WORKER_CHUNK_SIZE=50
MEDIA_GROUP_ASSIGNMENT_WORKER_LIMIT=3
MEDIA_GROUP_ASSIGNMENT_WORKER_CHUNK_SIZE=500
```

O worker registra heartbeat em `publication_worker_heartbeats` com `worker_kind='media_deletion'`. A validação esperada após o restart é que o health consolidado mostre 3 workers ativos e 0 workers stale: publicação, geração e manutenção de mídia.

## 19. Upload direto ao Storage para todos os tamanhos

Em 2026-08-11, o fluxo principal de upload da galeria foi ajustado para enviar todos os arquivos diretamente do navegador para o Supabase Storage.

Antes desta etapa, arquivos pequenos ainda podiam atravessar `POST /api/media`, fazendo a Vercel receber o binário, calcular hash e reenviar para o Storage. Agora o cliente usa o envio direto ao bucket `instagram-media` para qualquer tamanho aceito pela galeria e chama `POST /api/media/complete` apenas para registrar metadados, deduplicar por checksum e associar grupo inicial.

Impacto operacional:

- Menos tráfego binário passando por funções serverless.
- Menor risco de timeout/memória na Vercel durante uploads em massa.
- O controle de retry do navegador continua ativo.
- A API `POST /api/media` permanece como rota de compatibilidade, mas deixou de ser o caminho principal da interface.

Validação executada:

- `npm run build` passou localmente;
- não houve migration nova nesta etapa.

## 20. Correção de falsos positivos no health consolidado

Em 2026-08-11, após o deploy da Vercel com `/api/internal/operational-health`, o endpoint respondeu corretamente, mas retornou `503/unhealthy` porque heartbeats antigos de processos PM2 com IDs baseados em PID continuavam sendo contados como workers parados.

Correções aplicadas:

- `scripts/workers/media-maintenance-worker.mjs` passou a registrar heartbeat via `upsert_publication_worker_heartbeat`.
- O worker de manutenção de mídia foi configurado com ID estável `MEDIA_MAINTENANCE_WORKER_ID=athena-vps-media-maintenance-1`.
- A migration `072_deduplicate_worker_heartbeats.sql` atualizou `get_worker_operational_status` e `get_global_operational_health` para considerar o worker lógico mais recente por tipo/host/ID-base, evitando que PIDs obsoletos causem alerta crítico permanente.
- A migration também criou `prune_stale_publication_worker_heartbeats(p_older_than_hours)` para limpeza manual por `service_role` quando necessário.

Validação pós-correção:

```bash
cd /opt/athena-worker
npm run worker:operational-health
```

Resultado observado:

```json
{
  "httpStatus": 200,
  "ok": true,
  "operationalStatus": "degraded",
  "signals": { "critical": 0, "warning": 1 },
  "workers": { "registered": 6, "active": 3, "stale": 0, "errors": 0 }
}
```

O estado `degraded` restante vem de aviso de lag máximo da fila, não de worker parado. Para inspecionar o worker de mídia:

```bash
pm2 logs athena-media-maintenance-worker --lines 40 --nostream
```

## 24. Restauração do spool de staging, troca de worker e renovação de URL

Fase 8 do `plans/plano-despacho-instagram-1000-perfis-sem-descarte-2026-08-28.md`. Procedimentos validados nesta sessão (não teóricos): o padrão de deploy abaixo é literalmente o que foi usado nas Fases 4/5 e no fix do deadlock de `criticalDelay`, incluindo o incidente real de 28/08 e sua recuperação.

### 24.1. Restauração do spool (`/var/lib/athena-publication-spool`)

O spool é só um cache em disco de itens já validados no Supabase — a fonte de verdade continua sendo `publication_items` (`dispatch_staged_by`/`dispatch_staged_at`/`dispatch_staged_until`). Perder o spool inteiro **não perde publicações**: o pior caso é os itens staged ficarem presos até `dispatch_staged_until` expirar e então voltarem a ser elegíveis para um novo staging.

Se o spool precisar ser recriado do zero (disco corrompido, diretório apagado por engano):

```bash
pm2 stop athena-publication-worker
rm -rf /var/lib/athena-publication-spool
install -d -m 700 /var/lib/athena-publication-spool
pm2 restart athena-publication-worker --update-env
```

O worker recria o diretório sozinho na inicialização (`PublicationDispatchSpool.initialize()`), mas criar explicitamente evita uma corrida entre o primeiro ciclo de staging e o primeiro ciclo de dispatch. Depois do restart, confirme que o worker está recuperando itens novos:

```bash
pm2 logs athena-publication-worker --lines 40 --nostream | grep -E "staging:|stagedDispatch:"
```

Se o spool ficar com arquivos `.tmp` órfãos (worker morto no meio de uma escrita), **não precisa intervenção manual** — `PublicationDispatchSpool.initialize()` já limpa `.tmp` órfãos a cada inicialização (validado com 1.000 envelopes + 2 `.tmp` órfãos em `scripts/workers/publication-dispatch-spool.test.mjs`, recuperação em ~2ms).

### 24.2. Troca do worker (deploy de código novo)

Sequência real usada nesta sessão (backup + `node --check` + confirmação de resolução real de módulo + restart isolado):

```bash
# No Windows, a partir do repositório local:
scp -i C:\Users\<usuario>\.ssh\athena_vps_worker_ed25519 \
  scripts/workers/publication-worker.mjs \
  scripts/workers/publication-direct-dispatch.mjs \
  scripts/workers/publication-dispatch-spool.mjs \
  scripts/workers/adaptive-bulk-controller.mjs \
  scripts/workers/publication-pressure-signal.mjs \
  root@<ip-da-vps>:/tmp/
```

```bash
# Na VPS:
runtime_dir=/opt/athena-worker
worker_dir="$runtime_dir/scripts/workers"
backup_suffix="before-deploy-$(date -u +%Y%m%dT%H%M%SZ)"

pm2 stop athena-publication-worker
for f in publication-worker.mjs publication-direct-dispatch.mjs publication-dispatch-spool.mjs; do
  [ -f "$worker_dir/$f" ] && cp -a "$worker_dir/$f" "$worker_dir/$f.$backup_suffix"
done
install -m 644 /tmp/*.mjs "$worker_dir/"

node --check "$worker_dir/publication-worker.mjs"
node --check "$worker_dir/publication-direct-dispatch.mjs"

# node --check só valida sintaxe — não pega dependência de módulo ausente. Isso causou um
# incidente real em produção (28/08/2026, @aws-sdk/client-s3 não instalado). Sempre confirmar
# resolução real dos imports antes do restart:
(cd "$runtime_dir" && node --input-type=module -e "await import('$worker_dir/publication-worker.mjs')") \
  || { echo 'FALHA: não resolveu os imports. NÃO reiniciar.'; exit 1; }

pm2 restart athena-publication-worker --update-env
pm2 save
```

Depois do restart, confirmar por pelo menos 2-3 ciclos (10-20s) que não há erro novo:

```bash
wc -l /root/.pm2/logs/athena-publication-worker-error.log   # anotar antes e depois
pm2 jlist | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=JSON.parse(d).find(x=>x.name==='athena-publication-worker');console.log(JSON.stringify({pid:p.pid,status:p.pm2_env.status,unstable:p.pm2_env.unstable_restarts}))})"
```

Rollback: restaurar os arquivos `.$backup_suffix` sobre os atuais e repetir `node --check` + restart isolado — nunca usar `pm2 delete`/recriar o processo do zero, isso perde `pm2 save`/o estado salvo de todos os outros workers na mesma lista.

### 24.3. Renovação de snapshot/URL expirado

`stagingLeaseSeconds` (`PUBLICATION_WORKER_STAGING_LEASE_SECONDS`, padrão 1200s) e `stagedDispatchLeaseSeconds` (`PUBLICATION_WORKER_STAGED_DISPATCH_LEASE_SECONDS`, padrão 900s) limitam por quanto tempo um item pode ficar staged/ativado sem ser reivindicado de novo. Se o worker cair por mais tempo que isso com itens staged, o item volta a ficar elegível para `claim_publication_dispatch_staging_items` automaticamente quando `dispatch_staged_until` expira — **não precisa renovação manual de URL**, o próximo ciclo de staging gera um snapshot/URL assinada nova do zero (`preparePublicationDispatchEnvelope` sempre assina uma URL nova, nunca reaproveita uma antiga entre ciclos).

Se um item específico estiver preso com uma URL/criação suspeita de ter expirado (ex.: mais de 24h staged, incomum), a ação segura é liberar manualmente o staging dele para forçar reprocessamento:

```sql
-- Rodar via Supabase (service_role), substituindo o item_id real:
select release_publication_dispatch_staging('<worker_id_atual>', array['<item_id>']::uuid[]);
```

Isso não afeta `execute_at`/`status` do item — ele só volta a ficar elegível para um novo ciclo de staging, que assina uma URL nova.

### 24.4. Referência rápida: os cinco estados no painel `/operacao`

Desde a Fase 8, `InstagramObservabilityCenter` mostra, por organização (via `get_publication_dispatch_state_snapshot`, refrescado por `refresh_publication_dispatch_state_snapshots` a cada ciclo de manutenção — `app/api/internal/instagram-observability-maintenance/route.ts`):

- **Pré-carregado**: itens com `dispatch_staged_by` setado (no spool, aguardando `execute_at`).
- **Aguardando cota**: itens `waiting` sem `creation_id`, com `next_attempt_at` no futuro — proxy de adiamento por reserva de capacidade negada.
- **Enviado ao provedor**: itens com `creation_id` setado em `preparing`/`publishing`.
- **Perfis desconectados**: contagem de perfis com `status <> 'online'` na organização.
- **Backlog parado/avançando**: compara o total ativo entre duas leituras (`publication_dispatch_backlog_trend`) — só sinaliza "parado" quando existe backlog real (`activeTotal > 0`) e o total não muda por mais de 10 minutos (`p_stalled_after_seconds`).

Limitação conhecida: o tamanho do spool em disco da VPS **não aparece por organização** (o spool é um diretório compartilhado, sem metadado por organização no heartbeat atual) — para ver o total global, usar `ls /var/lib/athena-publication-spool | wc -l` direto na VPS.
