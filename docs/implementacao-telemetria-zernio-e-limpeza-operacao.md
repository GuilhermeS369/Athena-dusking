# Implementação — telemetria Zernio e limpeza de visualização operacional

## Escopo entregue

Foram implementados apenas os controles aprovados:

- telemetria leve e não bloqueante das chamadas Zernio de criação e consulta de postagem;
- limpeza da visualização nos painéis **Publicações com atenção** e **Eventos de publicação** da rota [`/operacao`](../app/(painel)/operacao/page.tsx).

Não foram alteradas concorrência, limite de lote, timeout de 25 segundos, política de retry, circuit breaker ou configuração de VPS. As alternativas de limitação adaptativa permanecem exclusivamente no [Plano B](../plans/plano-prevencao-timeouts-zernio-publicacao.md).

## Telemetria Zernio

As migrations [`180_zernio_request_telemetry_and_operation_log_visibility.sql`](../supabase/migrations/180_zernio_request_telemetry_and_operation_log_visibility.sql) e [`181_zernio_request_telemetry_null_connection_rollups.sql`](../supabase/migrations/181_zernio_request_telemetry_null_connection_rollups.sql) já estão aplicadas no Supabase.

O worker acumula dados em memória durante o ciclo e faz uma tentativa destacada de persistência depois do despacho. Essa gravação nunca é aguardada pela publicação: se a RPC falhar, o buffer daquele flush é descartado e a fila continua normalmente.

### Dados armazenados

- rollups de cinco minutos por organização, conexão, operação e resultado em `zernio_publication_request_rollups`;
- histograma de latência e duração mínima, máxima e somada;
- detalhes somente para timeout, HTTP, rede e erro de parse em `zernio_publication_request_anomalies`.

Diagnósticos removem URLs e tokens Bearer. Não são gravados headers de autorização, chaves Zernio, URLs assinadas, mídia, payloads ou legendas.

### Consulta de validação

Depois que o worker atualizado tiver processado publicações Zernio, consultar com acesso administrativo:

```sql
select
  window_started_at,
  operation,
  outcome,
  sum(request_count) as requests,
  round(sum(duration_sum_ms)::numeric / nullif(sum(request_count), 0)) as average_duration_ms
from public.zernio_publication_request_rollups
where window_started_at >= timezone('utc', now()) - interval '24 hours'
group by 1, 2, 3
order by 1 desc, 2, 3;
```

## Limpar da visualização

O botão só é exibido para administradores e operadores. Ele registra um cursor por organização, usuário e escopo em `operational_log_clear_actions`; não executa `delete` sobre itens da fila nem eventos.

- **Limpar da visualização** oculta registros existentes até o instante de clique apenas para o usuário atual.
- Registros novos continuam aparecendo.
- **Restaurar visualização** remove o cursor e mostra novamente o histórico preservado.
- As rotas paginadas [`operation-attention-items`](../app/api/operation-attention-items/route.ts) e [`operation-events`](../app/api/operation-events/route.ts) aplicam o mesmo cursor, portanto “Ver mais” e recarregamento de página permanecem consistentes.

## Implantação pendente

O banco já recebeu as migrations. Para iniciar a coleta e expor a interface em produção ainda é necessário publicar o aplicativo e implantar/reiniciar controladamente o worker da VPS com [`publication-worker.mjs`](../scripts/workers/publication-worker.mjs). A reinicialização não deve coincidir com uma janela crítica de publicações.

## Validações executadas

- `node --check scripts/workers/publication-direct-dispatch.mjs`;
- `node --check scripts/workers/publication-worker.mjs`;
- `node --test scripts/workers/publication-direct-dispatch.test.mjs`: 17 testes aprovados;
- `npm run build`: build e verificação de tipos aprovados;
- `npx supabase migration list`: migrations 180 e 181 alinhadas entre local e remoto.
