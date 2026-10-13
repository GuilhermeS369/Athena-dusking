# VPS de variantes de vídeo — estado final e como religar

Levantamento feito em **13/10/2026, ~11:55 BRT**, com a máquina ainda ligada, só por leitura (SSH, banco e bucket). Nada foi alterado nela.

Documento de referência do recurso: [fila-de-publicacao-MASTER.md](fila-de-publicacao-MASTER.md) (seções 1.1, 1.3, 2, 3, 4, 6.1, 9, 11 e a pendência "Variante de vídeo por post" da seção 12). Este arquivo não substitui o mestre: registra o que existia na máquina e a receita para montar outra.

Legenda usada abaixo: **[verificado]** = conferido hoje na máquina, no banco, no bucket ou no código; **[inferência]** = conclusão tirada de documento ou código, não testada.

---

## 1. O que era e por que foi desligada

- Segunda VPS do Athena, criada em **20/09/2026**, só para gerar a "variante de vídeo": um arquivo único por post de Reel, montado com ffmpeg a partir do original, para que o mesmo vídeo não subisse com bytes idênticos em dezenas de perfis (migrations 436, 439 e 441).
- Rodava um único processo, `athena-video-variant-worker`. Não publicava, não lia token de perfil, não mexia na fila dos publicadores.
- A opção só existia na **programação em massa** (Rotação, Diário, Sequencial). O último plano com variante foi criado em **25/09/2026 16:48 BRT**; o último movimento de banda do worker é de **29/09/2026**.
- Em 10/10/2026 a postagem passou para a **postagem contínua por grupo** (migration 443), que não usa variante. Em 13/10/2026 o dono decidiu **cancelar a máquina**. Desde 29/09 ela só fazia um claim vazio a cada 20 s.

---

## 2. Estado em que ficou (13/10/2026)

### Máquina

| Item | Valor |
|---|---|
| Apelido SSH | `athena-variantes` (em `C:\Users\guilh\.ssh\config`, chave `~/.ssh/athena_vps_worker_ed25519`) |
| Endereço | `root@187.127.253.65`, hostname `srv1995489` |
| Plano | Hostinger KVM 4 |
| CPU / RAM / disco | 4 vCPU (AMD EPYC 9354P) / 15 GiB (882 MiB em uso) / 193 GB (14 GB em uso, 8%) |
| Swap | nenhum |
| Sistema | Ubuntu 26.04.1 LTS (`resolute`), kernel `7.0.0-30-generic`, fuso UTC, relógio sincronizado (chrony) |
| Ligada desde | 20/09/2026 18:38 BRT — **nunca foi reiniciada** (há `/var/run/reboot-required` pendente) |
| Tráfego desde a criação (`/proc/net/dev`, `eth0`) | **1.028,5 GB enviados**, 16,8 GB recebidos |

### Programas

| Programa | Versão | De onde veio |
|---|---|---|
| Node.js | 22.22.1 (`/usr/bin/node`) | apt, repositório `universe` do próprio Ubuntu 26.04 (sem NodeSource) |
| npm | 9.2.0 | apt (`universe`) |
| ffmpeg / ffprobe | 8.0.1-3ubuntu2 | apt (`universe`); tem `h264_metadata=sei_user_data` (conferido com `ffmpeg -h bsf=h264_metadata`) |
| PM2 | 7.0.3 (`/usr/local/bin/pm2`) | `npm install -g pm2` |
| pm2-logrotate | **não instalado** | — (`module_conf.json` vazio, nenhum módulo) |

Comando de instalação registrado no histórico do apt: `apt-get install -y -qq ffmpeg nodejs npm`. Depois disso só rodou `unattended-upgrade`.

### Segurança

| Item | Valor |
|---|---|
| sshd (efetivo, `sshd -T`) | `passwordauthentication no`, `kbdinteractiveauthentication no`, `permitrootlogin prohibit-password`, `pubkeyauthentication yes`, porta 22 |
| Onde está a regra | `/etc/ssh/sshd_config.d/00-athena.conf` (vence o `50-cloud-init.conf`: o sshd usa a primeira ocorrência) |
| ufw | ativo; entrada negada por padrão; só `22/tcp (OpenSSH)` liberado, v4 e v6 |
| Portas em escuta | só 22 (e o resolvedor local em 127.0.0.53/54) |
| Usuários com shell | só `root` |
| fail2ban | não instalado |
| Atualização automática | `unattended-upgrades` ligado |
| crontab | nenhum (`no crontab for root`) |

### Processo PM2

| Item | Valor |
|---|---|
| Nome / id PM2 | `athena-video-variant-worker` / 0 |
| Comando | `/usr/bin/npm run worker:video-variants` → `node scripts/workers/publication-video-variant-worker.mjs` |
| cwd | `/opt/athena-variants` |
| Estado | `online`, 82 MB, 0% de CPU |
| Reinícios | 3, todos manuais (troca de código): 20/09 23:22, 22/09 12:06 (receita `bookend`) e 23/09 23:47 BRT (níveis, migration 441). No ar desde o último |
| Parâmetros | `autorestart: true`, `max_restarts: 20`, `restart_delay: 5000`, `kill_timeout: 30000`, `log_date_format: 'YYYY-MM-DD HH:mm:ss Z'` |
| Env do processo (nomes) | `NODE_ENV`, `VIDEO_VARIANT_WORKER_ID`, `VIDEO_VARIANT_WORKER_LEAD_HOURS`, `VIDEO_VARIANT_WORKER_DB_CONCURRENCY`, `VIDEO_VARIANT_WORKER_CLAIM_LIMIT`, `VIDEO_VARIANT_WORKER_CACHE_DIR`, `VIDEO_VARIANT_WORKER_CACHE_MAX_GB`, `VIDEO_VARIANT_WORKER_BANDWIDTH_QUOTA_TB` |
| Valores (não são segredo) | `production`, `athena-variants-1`, `30`, `2`, `12`, `/var/cache/athena-variants`, `60`, `16` — iguais a `deploy/variants/ecosystem.config.cjs` |
| `pm2 save` | `/root/.pm2/dump.pm2` de 22/09 12:06 BRT, com este mesmo processo e as mesmas chaves |
| Início no boot | `pm2-root.service` **enabled**, porém **inactive**: o daemon do PM2 em uso foi iniciado à mão pela sessão SSH e a máquina nunca reiniciou. **A volta sozinha depois de um reboot nunca foi testada** |

### Arquivos

Árvore de `/opt/athena-variants` (537 MB, tudo em `node_modules`; não é um clone git):

```
/opt/athena-variants
├── .env.worker                       (733 bytes, modo 600, root)
├── package.json                      (cópia de 20/09/2026)
├── package-lock.json                 (cópia de 20/09/2026)
├── deploy/variants/ecosystem.config.cjs
├── node_modules/                     (537 MB; `npm ci` em 20/09: "added 76 packages")
└── scripts/workers/
    ├── publication-video-variant-worker.mjs
    ├── publication-video-variant-worker.test.mjs
    ├── video-variant-recipes.mjs
    └── video-variant-recipes.test.mjs
```

- **Os três arquivos que importam são idênticos ao repositório** (SHA-256 igual ao `HEAD` de 13/10/2026): o worker, as receitas e o `ecosystem.config.cjs`. Último commit que tocou neles: `dd6d654`. Nada precisa ser copiado de volta da máquina.
- `.env.worker` tem sete variáveis (só nomes): `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_INSTAGRAM_MEDIA`, `R2_BUCKET_INSTAGRAM_VARIANTS`. Não há `.env.local`.
- Bibliotecas que o worker usa: `@aws-sdk/client-s3` 3.1120.0 e `@supabase/supabase-js` 2.111.0. O resto do `node_modules` (Next etc.) veio junto do `package.json` e não é usado.
- Cache dos originais, `/var/cache/athena-variants`: **10,96 GB, 1.419 arquivos `.src`** (o mais novo de 25/09) mais `bandwidth.json` (contador do worker: 936,7 GB em setembro, somando download e upload; último dia com movimento 29/09).
- Em `/root`: `endurecer.sh` (reproduzido na seção 4), logs da instalação, os scripts dos ensaios de 22–24/09 (`bench-edicoes.sh`, `emenda.sh`, `emenda2.sh`, `meio.sh`, `meio2.sh`), as cópias de segurança `antes-bookend/` e `antes-niveis/` (versões antigas do worker) e os três scripts deste levantamento. Tudo isso se perde com a máquina; as conclusões dos ensaios estão na seção 11 do mestre.

### Log do worker

`/root/.pm2/logs/athena-video-variant-worker-out-0.log` (3,7 KB) e `...-error-0.log` (9,7 KB). **O worker não escreve nada quando o claim vem vazio**: só loga ao iniciar, ao encerrar e em erro. O único sinal de que está vivo e ocioso é o heartbeat.

| Período (BRT) | Variantes prontas | Enviado ao R2 | Apagadas (coleta) | Tempo médio de ffmpeg | Menor folga antes do post |
|---|---|---|---|---|---|
| 20/09 19:32 → 20/09 23:22 | sem registro (processo trocado sem linha de encerramento) | — | — | — | — |
| 20/09 23:22 → 22/09 12:06 | 17.282 | 68,7 GB | 4.888 | 3,2 s | 23,29 h |
| 22/09 12:06 → 23/09 23:47 | 32.742 | 423,7 GB | 27.249 | 2,1 s | 1,05 h |
| 23/09 23:47 → hoje | 45.899 | 427,3 GB | 64.956 | 1,8 s | 30 h (último lote) |
| **Soma** | **95.923** | **919,6 GB** | **97.093** | | |

Última linha do log de saída: `iniciado` em 23/09 23:47 BRT. Log de erro: 12 `video_variant_ffmpeg_failed` (retentáveis; uma falha de asserção do codificador AAC em 21/09 e as demais no mesmo segundo de um reinício — **[inferência]** ffmpeg interrompido pelo próprio reinício) e 1 `fetch failed` em 29/09 21:43 BRT. Nenhuma colisão de bytes, nenhum aviso de franquia.

### Banco (produção, projeto Supabase `athena`)

| O que | Valor |
|---|---|
| `publication_item_video_variants` | **0 linhas** em qualquer status (a tabela ocupa 87 MB de espaço já liberado, sem efeito) |
| `bulk_publication_plans` com `video_variant_recipe` | **39 planos, todos `completed`**, de 2 organizações: 18 `light`, 15 `bookend`, 5 `micro`, 1 `bookend_mid`. Primeiro em 20/09/2026 20:08 BRT, **último em 25/09/2026 16:48 BRT** |
| Planos com variante ainda ativos | 0 |
| Itens da fila bloqueados por variante (`preparation_variant_*`) | 0 |
| Heartbeat `athena-variants-1` (`worker_kind = 'media_processing'`) | `idle`, visto 17 s antes da consulta (13/10 11:55:49 BRT), host `srv1995489`, versão 2.0.0. Metadata: `role=video_variants`, `ready=45899`, `failed=0`, `collisions=0`, `deleted=64956`, `averageEncodeMs=1821`, `cache={files:1419, bytes:10,96 GB}`, `bandwidthLevel=ok`, `bandwidthMonthBytes=0` |
| Outro heartbeat `media_processing` | `video-variant-srv1995489-11534`, `stopped` desde 20/09 19:32 BRT (teste do primeiro dia; inofensivo) |
| Funções e regras da 436/439/441 | presentes: as oito RPCs de variante existem e os dois `check` de receita aceitam `container`, `micro`, `light`, `bookend`, `bookend_mid` |

### Bucket R2

| O que | Valor |
|---|---|
| Bucket de variantes | `athena-instagram-variants` — **0 objetos** (listado hoje pela API S3, com a credencial da própria VPS) |
| Ciclo de vida | duas regras ligadas: `apagar-variantes-com-10-dias` (expira em 10 dias) e `abortar-multipart-1-dia` |
| Bucket de origem | `instagram-media` (o worker só lê) |

---

## 3. Antes de cancelar, e o que muda com ela desligada

### 3.1 O que já está resolvido [verificado]

- Não há variante pendente, pronta ou em processamento; não há plano com variante ativo; não há item bloqueado esperando variante.
- O bucket de variantes está vazio. A coleta de lixo, que era feita por este worker, **não deixou resto**. Se sobrasse algo, a regra de 10 dias apagaria sozinha.
- Nada de único mora na máquina: o código é igual ao do repositório e os valores do `.env.worker` são os mesmos dos publicadores (seção 4.6).

### 3.2 Passos do dono, nesta ordem (nenhum foi executado)

**1. Esvaziar `BULK_VIDEO_VARIANT_ORG_IDS` na Vercel e fazer um deploy.** A variável **existe** em Production (criada há 23 dias); o valor é cifrado e não foi lido. É ela que decide quem vê e pode confirmar "Vídeo único por post". Vazia = ninguém. Mudança de env na Vercel só vale no deploy seguinte.

Por que é o passo mais importante: com o worker desligado, um plano criado com variante **perde todos os Reels**. O item nasce com a linha da variante `pending`, ninguém a produz, a preparação bloqueia o item (`preparation_variant_pending`) e ele vence pelo corte de 300 s como `publication_past_due`. **O arquivo original nunca sobe** (decisão do dono de 20/09/2026, seção 3 do mestre).

**2. Parar o worker com sinal de parada, antes de cancelar.** Assim o último heartbeat fica gravado como `stopped`:

```bash
ssh athena-variantes "pm2 stop athena-video-variant-worker"
```

Conferir (de `C:\Users\guilh\.claude\projects\C--Dusking-Pomodoro\tools\pgq`):

```bash
node q.mjs -e "select worker_id, status, last_seen_at from publication_worker_heartbeats where worker_kind = 'media_processing'"
```

Tem de mostrar `athena-variants-1` com `status = stopped`. O motivo está em 3.3 (saúde operacional).

**3. Cancelar a KVM 4 no hPanel da Hostinger** e desligar a renovação automática.

**4. Depois do cancelamento:**
- Em `C:\Users\guilh\.ssh\config`, apagar ou comentar o bloco `Host athena-variantes` (o IP pode ser dado a outro cliente).
- Nas ferramentas locais (fora do repositório): tirar a entrada `variantes` de `tools/vpsmon/server.mjs` e parar de usar `tools/pgq/monvar.mjs`, que alerta "worker de variantes sem heartbeat há mais de 3 min".
- Atualizar o mestre, que ainda descreve a máquina como ligada (seção 1.1, tabela da seção 4, pendência da seção 12). Não foi editado neste trabalho.

### 3.3 O que muda no resto do sistema

| Ponto | O que acontece | Base |
|---|---|---|
| Publicadores com `PUBLICATION_WORKER_VIDEO_VARIANTS=true` | Nada. Com a chave ligada o select do item embute a tabela de variantes; item sem linha de variante segue o caminho normal, com o arquivo original. É o que acontece em produção desde 29/09, com a tabela vazia. **Pode ficar ligada**; desligar exigiria reiniciar os cinco, um por vale, sem ganho | `deploy/instagram/ecosystem.config.cjs` tem `true` nos cinco **[verificado no repositório, não no PM2 da `athena-nova`]**; comportamento **[inferência]** do mestre e de `publication-direct-dispatch.mjs` |
| Rotas de plano em massa | `review` e `confirm` recusam `videoVariant` quando a organização não está em `BULK_VIDEO_VARIANT_ORG_IDS` | **[verificado]** `app/api/bulk-publications/{review,confirm}/route.ts` |
| Postagem contínua (443) | Não cria linha de variante; a migration 443 não cita a tabela | **[verificado]** por busca na migration |
| Tela Operação → "workers" | Não mostra este worker: a rota lista só `publication`, `publication_planner`, `media_deletion`, `profile_analytics`, `zernio_sync` | **[verificado]** `app/api/operation/observability/workers/route.ts` |
| **Saúde operacional global** | `get_global_operational_health` conta worker de **qualquer tipo**. Heartbeat velho com status diferente de `stopped`/`error` vira `stale_workers = 1` → sinal crítico → `/api/internal/operational-health` responde **503 `unhealthy`**, para sempre. Com `stopped`, a linha sai da conta depois de 120 s. Hoje: `degraded`, `stale_workers = 0` | **[verificado]** no corpo da função em produção e em `app/api/internal/operational-health/route.ts` |
| `get_worker_operational_status` / `get_operational_alerts` | Mesma regra de escopo: linha `stopped` e velha some; linha `idle` e velha aparece como parada | **[verificado]** na função; quem consome na tela **não foi rastreado** |
| Bucket `athena-instagram-variants` | Fica vazio e sem custo. **Não apagar**: religar precisa dele e da regra de 10 dias | **[verificado]** |
| Tabela, RPCs, migrations 436/439/441 | Ficam. Não remover nem reaplicar | **[verificado]** que existem |
| Cópia das chaves | O disco da VPS guarda a `SUPABASE_SERVICE_ROLE_KEY` e o token R2 dos publicadores. Somem com a máquina; a rotação de chaves pendente no mestre continua valendo | **[inferência]** |

Se a máquina for cancelada **sem** o passo 2, o conserto é apagar a linha do heartbeat (escrita no banco, a decidir com o dono):

```sql
delete from public.publication_worker_heartbeats where worker_id = 'athena-variants-1';
```

---

## 4. Religar numa KVM 4 nova, do zero

Convenções: blocos `powershell`/`bash` marcados **(Windows)** rodam no computador do dono, na raiz do repositório (`C:\Dusking\Pomodoro`); os marcados **(VPS)** rodam dentro de uma sessão `ssh athena-variantes`. No PowerShell 5.1 não encadeie comandos com `&&` nem use aspas dentro de aspas no `ssh`: um comando por vez.

### 4.1 Contratar

- Hostinger **KVM 4** (4 vCPU, 16 GB, 200 GB, franquia de 16 TB/mês).
- Imagem **Ubuntu 26.04 LTS**. A versão importa: é o apt do 26.04 que entrega Node 22 e **ffmpeg 8.0.1**. Em Ubuntu mais antigo o ffmpeg do apt é anterior e não foi testado com as receitas.
- Chave SSH: cadastrar a pública de `C:\Users\guilh\.ssh\athena_vps_worker_ed25519.pub` em **hPanel → Chaves SSH**. Não colar pelo Web console: o `authorized_keys` da Hostinger termina sem quebra de linha e a chave gruda no comentário deles (registrado no mestre, 20/09).

### 4.2 Apelido SSH (Windows)

Em `C:\Users\guilh\.ssh\config`, trocar só o `HostName` do bloco:

```
Host athena-variantes
    HostName <IP NOVO>
    User root
    IdentityFile ~/.ssh/athena_vps_worker_ed25519
```

Se o IP for reaproveitado, limpar a impressão digital antiga (Windows):

```bash
ssh-keygen -R <IP NOVO>
```

Testar (Windows):

```bash
ssh athena-variantes "hostname"
```

### 4.3 Endurecer

Salvar como `endurecer.sh` (é o script que rodou em 20/09/2026):

```bash
#!/bin/bash
set -e
# SSH so por chave. O sshd usa a PRIMEIRA ocorrencia de cada opcao: o 00- vence o 50-cloud-init.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-athena.conf
sshd -t
systemctl reload ssh
# Firewall: libera o SSH ANTES de ligar, para nao se trancar do lado de fora.
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
sshd -T | grep -E '^(passwordauthentication|permitrootlogin) '
ufw status | head -6
```

Enviar (Windows):

```bash
scp endurecer.sh athena-variantes:/root/endurecer.sh
```

Rodar (Windows):

```bash
ssh athena-variantes "bash /root/endurecer.sh"
```

Esperado: `passwordauthentication no`, `permitrootlogin prohibit-password`, `Status: active` com `OpenSSH ALLOW`. **Abra uma segunda sessão SSH para confirmar o acesso antes de fechar a primeira.**

### 4.4 Instalar Node, npm, ffmpeg e PM2 (VPS)

```bash
apt-get update
```

```bash
apt-get install -y ffmpeg nodejs npm
```

```bash
npm install -g pm2
```

Conferir versões (esperado: Node 22.x, ffmpeg 8.0.x, PM2 7.x):

```bash
node -v
```

```bash
ffmpeg -version | head -1
```

Conferir o recurso de que as receitas dependem (tem de imprimir uma linha `-sei_user_data`):

```bash
ffmpeg -hide_banner -h bsf=h264_metadata | grep sei_user_data
```

Se não imprimir, **pare**: as receitas gravam a marca única com esse filtro.

### 4.5 Diretórios e código

Criar os diretórios (Windows):

```bash
ssh athena-variantes "mkdir -p /opt/athena-variants/scripts/workers /opt/athena-variants/deploy/variants /var/cache/athena-variants"
```

O worker usa **só estes arquivos do repositório** (imports conferidos: `publication-video-variant-worker.mjs` importa `./video-variant-recipes.mjs`, módulos do Node, `@aws-sdk/client-s3` e `@supabase/supabase-js`; as receitas importam só `node:crypto`):

| Arquivo | Para quê |
|---|---|
| `package.json`, `package-lock.json` | script `worker:video-variants` e dependências |
| `scripts/workers/publication-video-variant-worker.mjs` | o worker |
| `scripts/workers/video-variant-recipes.mjs` | as receitas |
| `deploy/variants/ecosystem.config.cjs` | a receita do PM2 |

Copiar (Windows, um por vez):

```bash
scp package.json package-lock.json athena-variantes:/opt/athena-variants/
```

```bash
scp scripts/workers/publication-video-variant-worker.mjs scripts/workers/video-variant-recipes.mjs athena-variantes:/opt/athena-variants/scripts/workers/
```

```bash
scp deploy/variants/ecosystem.config.cjs athena-variantes:/opt/athena-variants/deploy/variants/
```

Instalar dependências (VPS, dentro de `/opt/athena-variants`):

```bash
cd /opt/athena-variants
```

```bash
npm ci --omit=dev
```

### 4.6 Montar o `.env.worker`

Sete variáveis, em `/opt/athena-variants/.env.worker`, modo 600. **Nenhum valor passa pelo chat nem entra no git**: copie de máquina para máquina.

| Variável | De onde vem o valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | a mesma dos publicadores: `/opt/athena-worker/.env.worker` na VPS `athena-nova` |
| `SUPABASE_SERVICE_ROLE_KEY` | idem (mesma service key dos publicadores) |
| `R2_ENDPOINT` | idem |
| `R2_ACCESS_KEY_ID` | idem (mesmo token R2 dos publicadores; o token próprio e restrito é pendência do mestre) |
| `R2_SECRET_ACCESS_KEY` | idem |
| `R2_BUCKET_INSTAGRAM_MEDIA` | `instagram-media` |
| `R2_BUCKET_INSTAGRAM_VARIANTS` | `athena-instagram-variants` (não pode ser igual ao de origem: o worker recusa iniciar) |

Jeito de copiar sem imprimir valor. Salvar como `filtrar-env.sh`:

```bash
#!/bin/bash
grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|R2_ENDPOINT|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET_INSTAGRAM_MEDIA|R2_BUCKET_INSTAGRAM_VARIANTS)=' /opt/athena-worker/.env.worker > /root/env.variantes
chmod 600 /root/env.variantes
cut -d= -f1 /root/env.variantes
```

Enviar para a VPS dos publicadores (Windows):

```bash
scp filtrar-env.sh athena-nova:/root/filtrar-env.sh
```

Rodar lá (Windows) — **tem de listar os sete nomes**; se faltar algum, complete o arquivo à mão na VPS de variantes:

```bash
ssh athena-nova "bash /root/filtrar-env.sh"
```

Levar de uma VPS para a outra, passando pelo computador sem gravar em disco (Windows):

```bash
scp -3 athena-nova:/root/env.variantes athena-variantes:/opt/athena-variants/.env.worker
```

Fechar a permissão (Windows):

```bash
ssh athena-variantes "chmod 600 /opt/athena-variants/.env.worker"
```

Apagar a cópia intermediária (Windows):

```bash
ssh athena-nova "rm /root/env.variantes"
```

Os tetos (`VIDEO_VARIANT_WORKER_*`) **não** vão no `.env.worker`: estão no `ecosystem.config.cjs`. O PM2 guarda o env do processo; para mudar um teto, edite o arquivo e use `pm2 restart athena-video-variant-worker --update-env`.

### 4.7 Teste antes do PM2 (VPS, em `/opt/athena-variants`)

Uma passada só: confere env, ffmpeg, banco e R2, grava um heartbeat e sai.

```bash
npm run worker:video-variants:once
```

Esperado: `[video-variant-worker] iniciado {...}` e `[video-variant-worker] encerrado {...}`, sem `erro fatal`.

### 4.8 Subir no PM2 (VPS, em `/opt/athena-variants`)

```bash
pm2 start deploy/variants/ecosystem.config.cjs
```

```bash
pm2 save
```

```bash
pm2 startup systemd -u root --hp /root
```

```bash
pm2 save
```

Rotação de log (a máquina original **não tinha**; o worker escreve pouco, mas um plano com erro em série enche o disco):

```bash
pm2 install pm2-logrotate
```

```bash
pm2 set pm2-logrotate:max_size 20M
```

```bash
pm2 set pm2-logrotate:retain 14
```

```bash
pm2 set pm2-logrotate:compress true
```

Testar o que a máquina original nunca testou — a volta depois de um reboot:

```bash
reboot
```

Depois de reconectar, tem de estar `online`:

```bash
pm2 ls
```

```bash
systemctl is-active pm2-root
```

### 4.9 Conferir que está vivo

O log **não** mostra o claim vazio: ocioso, o worker fica mudo. Conferir pelo heartbeat (Windows, em `tools\pgq`):

```bash
node q.mjs -e "select worker_id, status, hostname, round(extract(epoch from (now() - last_seen_at))) as seg_atras, metadata->>'bandwidthLevel' as banda, metadata->>'tightestLeadHours' as folga_h from publication_worker_heartbeats where worker_kind = 'media_processing' order by last_seen_at desc"
```

| Sinal | Esperado |
|---|---|
| `athena-variants-1` | `status = idle`, `seg_atras` abaixo de 120 (o heartbeat sai a cada 60 s; o claim, a cada 20 s quando vazio) |
| `pm2 ls` | `online`, reinícios parados |
| `pm2 logs athena-video-variant-worker --lines 30 --nostream` | uma linha `iniciado` com `workerId: 'athena-variants-1'`, `leadHours: 30`, `ffmpegConcurrency: 4`, `databaseConcurrency: 2`; nenhuma `falha no ciclo` |
| `ufw status` | ativo, só OpenSSH |

---

## 5. Religar o recurso no produto

A máquina de pé não liga nada sozinha. **A ordem é obrigatória** (seção 4 e pendência da seção 12 do mestre):

1. **Worker de variantes vivo** (seção 4.9).
2. **Os cinco publicadores com `PUBLICATION_WORKER_VIDEO_VARIANTS=true`** e com `R2_BUCKET_INSTAGRAM_VARIANTS` no `.env.worker` da `athena-nova`. Publicador sem a chave **posta o arquivo original**. Conferir no PM2 de lá (só nomes e a chave em questão) antes de seguir; se algum estiver desligado, ligar um por vale, começando pelo 5 (seção 8.2 do mestre).
3. **Migrations 436, 439 e 441 já estão aplicadas** em produção (conferido em 13/10/2026). **Não reaplicar.**
4. **Só então** preencher `BULK_VIDEO_VARIANT_ORG_IDS` na Vercel (ids separados por vírgula; `*` = todas; vazio = ninguém) e fazer deploy. Começar por uma organização de teste e um plano pequeno.
5. **Religar a tela que oferece a opção.** "Vídeo único por post" só existe na **programação em massa**, e ela está sendo desativada em 13/10/2026 por outra chave: `LEGACY_SCHEDULING_ENABLED` (`lib/publications/legacy-scheduling.ts`; só a string `true` liga; a variável não existia em Production no dia do levantamento). Religar variante exige uma das duas:
   - `LEGACY_SCHEDULING_ENABLED=true` na Vercel e novo deploy, voltando a programação em massa; **ou**
   - levar a opção para a postagem contínua, que **hoje não tem variante**. É trabalho novo: a linha da variante nasce dentro do gerador de plano em massa (`process_bulk_rotation_generation_chunk`, migration 436), e a postagem contínua (443) não passa por ele **[inferência]**.
6. Acompanhar o primeiro plano com as consultas da seção 9 do mestre ("posts de plano com 'vídeo único' não saem"). Meta: zero `publication_past_due` com `preparation_error_code = 'preparation_variant_pending'`.

Regras que continuam valendo ao religar:

- Receitas aceitas no painel: `micro` (nível 1), `bookend` (nível 2, padrão), `bookend_mid` (nível 3). `container` e `light` são recusadas na criação do plano.
- O worker trabalha **30 h à frente**, mais que as 24 h da preparação. Post criado a menos de 24 h leva um bloqueio que o worker desfaz ao concluir.
- Variante que não ficou pronta **não posta o original**; o item vence.
- Para voltar atrás: esvaziar `BULK_VIDEO_VARIANT_ORG_IDS` impede plano novo. Planos já criados continuam precisando do worker até o último post.

---

## 6. Custos e limites conhecidos

| Item | Valor | Origem |
|---|---|---|
| Franquia da KVM 4 | 16 TB/mês. O worker avisa no heartbeat em 60% e 80% e **não para sozinho** (parar viraria post perdido) | mestre, seção 4; **como a Hostinger mede não foi confirmado** |
| Banda usada de verdade | **1.028,5 GB enviados** em 9 dias de uso (20 a 29/09/2026) para ~96 mil variantes ≈ 10,7 MB por variante. Contador do worker: 936,7 GB em setembro | medido hoje em `/proc/net/dev` e `bandwidth.json` |
| Projeção do mestre | 16 TB cobrem ~43 mil posts/dia; a frota inteira daria 18,6 TB → KVM 8 | mestre, seção 12 |
| Tamanho médio da variante | 9,6 MB (919,6 GB / 95.923) | medido (log do worker) |
| Tempo de ffmpeg por vídeo | `micro` ~190 ms (15 s, 1080×1920); `bookend` ~1–2 s; `bookend_mid` ~2–3 s; `light` ~25–29 s em full HD | mestre, seção 11 |
| Tempo médio real | 1,8 s (45.899 variantes, depois da 441); 3,2 s na fase da `light` | medido (heartbeat e log) |
| Paralelismo | 4 ffmpeg ao mesmo tempo (um por núcleo, teto 8); no máximo 2 chamadas de banco simultâneas; lote de 12 | `ecosystem.config.cjs` e log |
| Cache de originais | 11 GB para 1.419 originais; teto de 60 GB; ~2.200 originais somavam 26 GB em 20/09 | medido; cabeçalho do worker |
| R2 | um `PutObject` por variante (~US$ 2/mês; fatiado custaria ~US$ 29); apagar é grátis | cabeçalho do worker (estimativa) |
| Banco | estimativa: +2,6% de chamadas e +0,4% de tempo no caminho quente com a frota inteira | mestre, seção 1.3; **nunca medido no `pg_stat_statements`** |
| Falhas | 12 de ffmpeg (todas retentáveis) em ~96 mil; 0 colisões de bytes | medido (log) |
| Mensalidade da KVM 4 | não registrada em nenhum documento | — |

---

## 7. O que não foi verificado

- **O valor de `BULK_VIDEO_VARIANT_ORG_IDS` na Vercel.** Só se confirmou que a variável existe em Production. Se estiver preenchida, a opção segue liberada para aquelas organizações enquanto a programação em massa estiver no ar.
- **O PM2 real da `athena-nova`.** Que os cinco publicadores têm `PUBLICATION_WORKER_VIDEO_VARIANTS=true` foi lido só no repositório. A tabela da seção 4 do mestre ainda diz "desligada (padrão `false`)", em desacordo com o `ecosystem.config.cjs` e com as 96 mil variantes publicadas.
- **Se o `.env.worker` da `athena-nova` tem as sete variáveis** (em especial `R2_ENDPOINT` e `R2_BUCKET_INSTAGRAM_VARIANTS`). O `filtrar-env.sh` da seção 4.6 mostra na hora.
- **A volta do PM2 depois de um reboot** na máquina original: `pm2-root` estava `enabled` mas `inactive`, e a máquina nunca reiniciou.
- **A receita da seção 4 não foi executada de ponta a ponta numa máquina nova.** Ela junta o que está instalado hoje, o histórico do apt, o `endurecer.sh` e os logs de instalação de 20/09. O `npm ci --omit=dev` com o `package.json` atual também não foi ensaiado (o da máquina é a cópia de 20/09).
- **O comportamento do publicador com a chave ligada e sem worker** não foi testado de propósito; a conclusão vem do mestre, do código e de duas semanas de produção com a tabela vazia.
- **Quem lê `get_worker_operational_status` / `get_operational_alerts` na tela** e se algo externo consulta `/api/internal/operational-health`. Não há cron da Vercel nem processo do PM2 apontando para essa rota no repositório; `npm run worker:operational-health` é manual.
- **Como a Hostinger mede a franquia** (só saída? entrada e saída?) e o preço do plano.
- **Se a programação em massa já está desativada em produção** no momento da leitura deste documento: a chave `LEGACY_SCHEDULING_ENABLED` estava em implementação por outra pessoa em 13/10/2026.
