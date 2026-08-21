# Plano de correção — worker e recuperação de agendamentos

## Objetivo e ordem obrigatória

1. Corrigir e comprovar o acionamento contínuo do worker em produção.
2. Validar o claim e a publicação com itens de teste.
3. Somente então aplicar a recuperação dos itens que já perderam horário.

Não executar a recuperação enquanto a causa do worker estiver aberta: isso apenas
transferiria os itens para novos horários sem garantir que serão processados.

## Diagnóstico registrado

Os itens afetados permaneceram com `status = waiting`, horário vencido,
`attempt_count = 0`, sem `claimed_by`, sem `lease_until` e sem evento de
processamento. A causa foi confirmada por uma chamada autenticada ao endpoint:
o RPC `claim_publication_items` falha com `column reference "batch_id" is
ambiguous`. A migration 029 reintroduziu a ambiguidade no CTE que atualiza o
lote. O cron existe e é aceito pela Vercel, mas cada chamada do dispatcher
termina em `503` antes de reivindicar um único item.

## Alterações de banco previstas

As migrations [`036_recover_missed_publication_slots.sql`](../supabase/migrations/036_recover_missed_publication_slots.sql)
e [`037_fix_publication_claim_and_recover_missed_schedules.sql`](../supabase/migrations/037_fix_publication_claim_and_recover_missed_schedules.sql)
devem ser aplicadas juntas. A primeira apenas instala a rotina; a segunda
corrige o claim e chama a recuperação antes de selecionar candidatos. Assim,
o worker já implantado deixa de publicar itens vencidos imediatamente depois da
correção do RPC.

Ela deverá:

- adicionar `publication_items.missed_schedule_recovery_count`, limitado a `0` ou `1`;
- identificar apenas itens `waiting`/`ready` já vencidos, sem lease e sem contêiner da Meta;
- preservar a faixa diária original de 10 minutos no fuso `America/Sao_Paulo`;
- se outro item ativo do mesmo perfil ocupa essa faixa no próximo dia, pular o dia inteiro;
- escolher o primeiro dia futuro livre e uma vaga de minuto entre `xx:01` e `xx:09`;
- gravar um evento com horário perdido, novo horário e motivo;
- permitir um único reagendamento automático;
- após uma segunda perda, marcar `failed` com `missed_schedule_requires_attention`, sem novo reagendamento.

### Exemplo obrigatório

```text
04/08 09:00 — item 1 vencido
05/08 09:00 — item 2 aguardando no mesmo perfil e faixa
06/08 09:00–09:09 — item 1 reagendado automaticamente
```

## Procedimento de aplicação após o worker corrigido

1. Executar `npx supabase db push --linked --dry-run` e confirmar somente a migration 036.
2. Aplicar a migration com `npx supabase db push --linked`.
3. Executar uma prévia dos itens vencidos e seus destinos calculados.
4. Revisar os destinos dos itens afetados antes de atualizar dados.
5. Rodar `recover_missed_publication_slots` uma vez.
6. Conferir que nenhum item ativo perdeu seu próprio horário e que os itens recuperados têm contador `1`.

## Alterações de aplicação previstas

- O dispatcher executará a recuperação antes do claim normal.
- O resultado do worker registrará contagens de itens recuperados e itens que exigem atenção.
- A fila exibirá horário original, horário novo e motivo de reagendamento.
- Itens que perderem horário após a recuperação serão destacados como intervenção necessária.

## Critérios de aceite do worker

- A origem do acionamento deve ter garantia de frequência compatível com o menor intervalo agendável.
- Cada execução deve produzir log de início, recuperação, claim e resultado.
- Um item devido deve mudar de `waiting` para `preparing`/`publishing` na primeira execução disponível.
- Cinco itens podem ser processados em paralelo sem impedir a próxima invocação do worker.
