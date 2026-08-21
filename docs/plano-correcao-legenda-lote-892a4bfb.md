# Plano de correção da legenda do lote `892a4bfb-e6d1-4d72-b941-ec9435178904`

## Diagnóstico confirmado em 04/08/2026

O lote criado por `aleidar1010@gmail.com` em 04/08/2026 às 01:57 (São Paulo) foi identificado pelo ID acima.

Consulta somente de leitura confirmou:

- 100 itens no total, todos no formato Reel, distribuídos em 2 perfis;
- 4 itens já publicados e 96 itens ainda em `waiting`;
- os 100 registros têm exatamente a legenda `VEJAM MEU STORYS`, com 16 unidades UTF-16;
- nenhum item possui o emoji `🚨` ou o restante do texto esperado;
- a próxima publicação ainda futura estava prevista para 04/08/2026 às 14:03 (São Paulo) e a última para 09/08/2026 às 09:38 (São Paulo).

Portanto, o problema ocorreu **antes da persistência no banco**. Não foi causado pela Meta nem pela publicação: inclusive os quatro itens já publicados chegaram ao worker com a legenda curta.

## Fluxo atual e causa provável

O texto em massa é capturado pela caixa `bulk.captions` em `app/postagem/group-composer-next.tsx` e depois é transformado por `bulk.captions.split('\n')` quando a distribuição é aplicada.

No modo **Uma por postagem**, essa divisão é intencional: cada linha é uma legenda diferente. Porém, no modo **Uma legenda para todas**, a mesma divisão elimina as quebras de linha e `captionForIndex` escolhe apenas a primeira linha. Para o texto informado, a primeira linha é `VEJAM MEU STORYS 🚨`; no banco o emoji também não chegou, indicando que ele provavelmente foi removido ou não estava no estado antes da submissão. Independentemente da origem específica do emoji, a lógica atual perde obrigatoriamente todo o conteúdo depois da primeira quebra de linha no modo compartilhado.

O endpoint aceita `caption` com até 2.200 unidades UTF-16 e a tabela usa `text` com a mesma verificação. O texto enviado tem aproximadamente 900 caracteres, portanto está bem abaixo do limite local. JSON, PostgreSQL `text`, JavaScript e `URLSearchParams` trabalham com Unicode e preservam o emoji `🚨`; não há necessidade técnica de removê-lo.

Os Reels e posts de imagem/carrossel são enviados à Meta com `caption` pelo publicador. Stories, por limitação do fluxo atual, não recebem a legenda no payload da Meta; isso é uma restrição separada e não afeta este lote de Reels.

## Correção de código proposta

1. Em `app/postagem/group-composer-next.tsx`, guardar a legenda compartilhada como uma única entrada do plano: `[bulk.captions]`, preservando quebras de linha e emoji. Manter `split('\n')` somente para o modo `per_post`.
2. Aplicar a mesma normalização à legenda individual, que hoje também quebra linhas antes de chegar ao plano. No modo compartilhado, deve usar `[event.target.value]`; no modo por postagem, usar `event.target.value.split('\n')`.
3. Extrair uma função pura, por exemplo `captionsFromInput(text, mode)`, e criar testes unitários para:
   - texto multilinha em modo compartilhado retornar um único valor idêntico;
   - texto multilinha em modo por postagem retornar uma legenda por linha;
   - emoji `🚨` e caracteres acentuados serem preservados;
   - payload próximo de 2.200 unidades ser aceito e um acima ser recusado pela API.
4. Acrescentar ao `textarea` um contador baseado em `value.length` e um `maxLength={2200}`, junto de aviso explícito sobre a regra de linhas para o modo por postagem.
5. Para diagnóstico futuro, registrar apenas metadados não sensíveis na criação do lote: comprimento da legenda e uma assinatura SHA-256 do texto, sem gravar duplicatas nem expor a legenda em logs.

## Procedimento seguro para atualizar somente os 96 itens pendentes

Não executar até a correção passar pela validação abaixo. O procedimento deve usar uma transação administrativa e restringir por `batch_id`, estado e horário futuro.

1. Pausar temporariamente o worker/cron de publicação para não haver disputa entre a leitura e a atualização.
2. Executar uma consulta de prévia que conte os itens alvo e agrupe por estado, exigindo exatamente 96 registros em `waiting` com `execute_at > now()` e `creation_id is null`.
3. Atualizar somente esses itens, com os três predicados obrigatórios:
   - `batch_id = '892a4bfb-e6d1-4d72-b941-ec9435178904'`;
   - `status = 'waiting'`;
   - `execute_at > now()` e `creation_id is null`.
4. Usar o texto completo, com a quebra de linha e `🚨`, como parâmetro SQL. Não interpolar o texto no comando manualmente.
5. Gravar um evento de auditoria por item com `event_type = 'updated'` ou um novo tipo explícito de correção, contendo: lote, motivo `caption_repair`, tamanho anterior, tamanho novo e hash novo. Não gravar o texto integral no metadata.
6. Validar na mesma transação que foram alteradas exatamente 96 linhas, que todas começam com `VEJAM MEU STORYS 🚨\nAcidente na BR-381` e que todas têm o mesmo comprimento/hash esperado.
7. Retomar o worker/cron e monitorar a primeira publicação corrigida. Os 4 itens já publicados não devem ser alterados, republicados ou removidos.

### SQL de referência — prévia, não mutável

```sql
select
  status,
  count(*) as quantidade,
  min(execute_at) as primeiro_horario,
  max(execute_at) as ultimo_horario,
  min(char_length(caption)) as menor_legenda,
  max(char_length(caption)) as maior_legenda
from public.publication_items
where batch_id = '892a4bfb-e6d1-4d72-b941-ec9435178904'
group by status
order by status;
```

### SQL de referência — execução parametrizada

O SQL deve ser executado como migração operacional controlada ou função administrativa com parâmetros `p_batch_id` e `p_caption`; não pelo cliente web.

```sql
begin;

with alvo as (
  select id
  from public.publication_items
  where batch_id = :p_batch_id
    and status = 'waiting'
    and execute_at > timezone('utc', now())
    and creation_id is null
  for update
), atualizado as (
  update public.publication_items item
  set caption = :p_caption
  from alvo
  where item.id = alvo.id
  returning item.id
)
select count(*) as itens_atualizados from atualizado;

-- Confirmar que o retorno foi exatamente 96 antes de `commit`.
commit;
```

Se a contagem não for 96, executar `rollback`, investigar os itens que mudaram de estado e repetir a prévia. Esta condição torna a operação idempotente e impede alterar itens publicados, em processamento ou criados pela Meta.

## Execução realizada em 04/08/2026

- A migração `038_add_caption_repaired_publication_event.sql` adicionou o evento auditável `caption_repaired`.
- A migração `039_repair_caption_for_batch_892a4bfb.sql` corrigiu os 96 itens pendentes. Uma quebra CRLF inicial introduzida pelo delimitador SQL foi removida de forma restrita pela migração `040_remove_accidental_leading_newline_from_repaired_batch_caption.sql`.
- A validação final remota confirmou que os 96 itens elegíveis receberam o texto completo, emoji e quebra de linha preservados. Durante a execução, 2 deles foram publicados; os 94 restantes continuam na fila com a legenda corrigida. Os 4 itens que já estavam publicados antes da correção permaneceram inalterados com a legenda curta original.

## Validação após a correção

1. Criar um lote de teste com dois Reels, uma legenda compartilhada multilinha contendo `🚨` e outra individual por linha.
2. Consultar `publication_items.caption` e comparar com o payload original byte a byte em UTF-8, além de confirmar o tamanho em JavaScript e `char_length` no PostgreSQL.
3. Validar o primeiro item futuro deste lote antes da execução e confirmar no evento/registro do worker que a legenda recebida mantém o texto completo.
4. Acompanhar a publicação na Meta; caso ela rejeite a legenda, o erro deve constar em `last_error_message`, sem truncamento silencioso.
