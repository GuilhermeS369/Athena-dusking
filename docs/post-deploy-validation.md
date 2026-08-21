# Runbook — validação pós-deploy

Este runbook valida se o deploy e a migration operacional dos workers estão funcionando antes de ligar qualquer worker real.

Nada aqui publica no Instagram. As validações são apenas leitura, autenticação e checagem de RPC.

## 1. Validar endpoint interno de saúde da fila

No PowerShell local:

```powershell
$APP_URL="https://SEU-DOMINIO-DA-VERCEL"
$SECRET="SEU_PUBLICATION_WORKER_SECRET"

Invoke-RestMethod `
  -Uri "$APP_URL/api/internal/publication-health" `
  -Headers @{ "x-publication-worker-secret" = $SECRET } `
  -Method GET
```

Retorno esperado:

```json
{
  "ok": true,
  "queue": {
    "counts": {},
    "activeItems": 0,
    "expiredLeases": 0,
    "dueRetries": 0,
    "overdue": 0
  },
  "checkedAt": "2026-08-11T..."
}
```

Os números podem ser diferentes se existir fila ativa.

## 2. Validar proteção do endpoint

Rode sem segredo:

```powershell
$APP_URL="https://SEU-DOMINIO-DA-VERCEL"

Invoke-RestMethod `
  -Uri "$APP_URL/api/internal/publication-health" `
  -Method GET
```

Retorno esperado: HTTP 401 com `Não autorizado.`

## 3. Validar RPC no Supabase

No SQL Editor do Supabase:

```sql
select *
from public.get_publication_queue_operational_summary(null);
```

O esperado é retornar linhas ou vazio, mas sem erro.

## 4. Validar tabelas operacionais

No SQL Editor do Supabase:

```sql
select *
from public.publication_worker_heartbeats
order by last_seen_at desc
limit 10;
```

Pode retornar vazio enquanto a VPS ainda não foi ligada.

```sql
select *
from public.publication_worker_settings
order by created_at desc
limit 10;
```

Também pode retornar vazio nesta etapa.

## 5. Validar tela de operação

Abra:

```text
https://SEU-DOMINIO-DA-VERCEL/operacao
```

Critérios:

- página abre sem erro 500;
- cards de fila ativa e recuperações aparecem;
- números podem ser zero se a fila estiver vazia;
- logs da Vercel não mostram erro em `/api/internal/publication-health`.

## 6. Diagnóstico rápido de erro

### HTTP 401

O segredo enviado não bate com `PUBLICATION_WORKER_SECRET` da Vercel ou a variável não existe.

### HTTP 500

O RPC não foi encontrado, migration não foi aplicada no banco correto, ou houve erro de grant.

### HTTP 503

`NEXT_PUBLIC_SUPABASE_URL` ou `SUPABASE_SERVICE_ROLE_KEY` está ausente/incorreto na Vercel.

## 7. Próximo passo após sucesso

Depois que este checklist passar, a próxima etapa segura é preparar a VPS em modo `observe` com `PUBLICATION_WORKER_DRY_RUN=true`.
