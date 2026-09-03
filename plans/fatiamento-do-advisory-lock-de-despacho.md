# Fatiar o advisory lock de despacho por organização

**Início:** 03/09/2026, ~00:55 UTC (21:55 BRT de 02/09)
**Motivo:** terceira ocorrência do mesmo mecanismo — ver seção 3-B de
[docs/fila-de-publicacao-mapa-de-controles.md](../docs/fila-de-publicacao-mapa-de-controles.md).

## O problema

`reserve_publication_dispatch_capacity` pega `pg_advisory_xact_lock` por
(organização, provedor) na linha 140 de
`supabase/migrations/341_reservation_cleanup_out_of_hot_path.sql`. O lock é de
transação: fica preso até o commit. Uma onda inteira é de uma organização só,
então **todos os despachos concorrentes serializam nesse único lock, cada um
segurando uma conexão do pool enquanto espera**.

O pool do PostgREST tem 41 conexões. Um único `athena-publication-worker` está
provisionado para 64+8+8 = 80 requisições simultâneas. Quando a fila enche, a
espera migra para dentro do Postgres e o pool acaba.

Já derrubou o sistema duas vezes: 31/08 (3.315 publicações perdidas) e 02/09
(painel fora do ar por horas).

## A decisão de projeto, e onde ela diverge do esboço anterior

A sessão "Agendador travado e fila parada" esboçou: *"N locks por hash do
perfil, cada um com 1/N da cota"*.

**A primeira metade fica, a segunda não.** Dividir a cota de 600 em N baldes
estrangula mais do que hoje: uma onda balanceada de 733 itens em 8 baldes dá
~92 por balde contra uma cota de 75, e passa a adiar *antes* do que o teto único
de 600 adiaria. Seria uma regressão de vazão vendida como correção de contenção.

**Decisão: fatiar só o lock, manter a cota global.**

Custo: até N−1 transações podem ler a mesma contagem e passar juntas, excedendo
o teto em ~1%. Aceitável porque este teto não é limite do provedor — a migration
355 registra que é *"proteção nossa, do banco"*, e que o limite real da Zernio
(25 posts/hora por conta, pico medido de 4/hora) tem folga de 6×.

As quatro checagens da função, por escopo:

| Checagem | Escopo | Lock que protege | Muda? |
|---|---|---|---|
| reentrância do próprio item | item | nenhum | não |
| `profile_min_interval` | perfil | lock por perfil (linha 141) | não |
| `profile_24h_limit` | perfil | lock por perfil (linha 141) | não |
| `provider_minute_limit` | organização | lock por organização (linha 140) | **sim** |

Só a última precisa do escopo de organização. As outras três já estão protegidas
pelo lock por perfil, que fica intacto.

## Revisão do desenho, antes de escrever qualquer linha

Seis achados. O primeiro é um bug que teria ido para produção.

### 1. `abs()` em `hashtextextended` estoura — não usar

O caminho óbvio para o balde seria `abs(hashtextextended(id, 7)) % N`. Está
errado: `hashtextextended` devolve `bigint`, e `abs(-9223372036854775808)`
levanta `22003 bigint out of range`, porque o menor bigint não tem positivo
correspondente. É raro, mas é um perfil específico derrubando um despacho
específico para sempre — o tipo de bug que só aparece em produção e não
reproduz.

**Correto:** `((hashtextextended(id, 7) % N) + N) % N`. O `%` lida com negativo
sem estourar, e a soma reposiciona no intervalo `[0, N)`.

### 2. O lock por perfil fica sem contenção — e isso é bom

Como o balde é **função do perfil**, dois despachos do mesmo perfil caem sempre
no mesmo balde. Logo, um deles já está esperando no lock de *balde* antes de
chegar ao lock de perfil. Na prática o lock por perfil deixa de ser disputado.

Fica mesmo assim: é barato, e as checagens de perfil continuam corretas por
construção em vez de por acidente.

### 3. Não há risco de deadlock, e isso foi verificado

A semente 5 (lock por perfil) só aparece em quatro arquivos — as versões
sucessivas desta mesma função — e sempre imediatamente **depois** da semente 4.
Nenhum outro caminho pega perfil antes de organização, então não existe ordem
inversa capaz de fechar ciclo.

### 4. Janela de troca durante o `create or replace`

Por alguns segundos, transações que começaram antes usam o lock antigo (por
organização) e as novas usam o de balde — e os dois **não se excluem
mutuamente**. Com a fila vazia é inofensivo. É mais um motivo para aplicar
agora, com 16 vencidos e 0 em voo, e não às 07:00.

### 5. Balde nulo cai para 1, não para 8

Se `dispatch_lock_shards` vier `null` por qualquer motivo, `coalesce(..., 1)`
reproduz exatamente o comportamento de hoje. O desconhecido deve degradar para o
conhecido, nunca para o novo.

### 6. A contagem do minuto passa a rodar N vezes em paralelo

Hoje o lock único serializa a consulta de `provider_minute_limit`. Fatiado, até
N delas rodam ao mesmo tempo. É exatamente a troca pretendida — sair de espera
serializada para trabalho paralelo — mas é carga nova no banco e precisa ser
observada na primeira onda grande.

Efeito colateral menor: a coluna nova entra em `to_jsonb(setting_row)`, que é
devolvido no retorno da função e registrado no log do worker. É aditivo.

## Etapas

- [x] **1. Ler a função inteira** e mapear cada checagem ao seu escopo real
- [x] **2. Decidir o desenho** (lock fatiado, cota global) com o custo explícito
- [x] **3. Escrever este plano**
- [x] **3-A. Revisar o desenho antes de codar** — 6 achados, 1 bug evitado
- [x] **4. Verificar a infraestrutura de teste** disponível para função SQL
- [x] **5. Escrever a migration 360** — lock por (org, provedor, balde), balde =
      `hashtextextended(profile_id) % N`, cota global preservada
- [x] **6. Número de baldes configurável no banco**, não em env, seguindo a
      seção "No BANCO, não em env" do mapa de controles
- [x] **7. Ordem de locks preservada** (balde → perfil) para não abrir deadlock
- [x] **8. Testes** cobrindo a aritmética do balde e a preservação da cota
- [x] **9. `npx tsc --noEmit` e `npm test` limpos**
- [x] **10. Aplicar em produção** com a fila vazia
- [~] **11. Validar** — PARCIAL: sem regressão, mas o volume até agora não
      exercita o lock. A validação real é a onda das 07:00.
- [x] **12. Commit** com o raciocínio registrado
- [x] **13. Atualizar o mapa de controles** com o resultado
- [x] **14. Corrigir a premissa da tarefa agendada das 07:30**, que ainda
      descreve o teto como 1200

## Registro de execução

_(preenchido conforme cada etapa termina — nada aqui é escrito antes de acontecer)_

### Etapas 5-8 — migration 360 (feitas)

`supabase/migrations/360_shard_dispatch_advisory_lock.sql`.

O corpo da funcao foi **extraido programaticamente** do texto de 341 e patcheado,
em vez de transcrito a mao — uma funcao de 300 linhas rescrita manualmente e um
convite a mudar algo sem querer. Conferido apos o patch: lock por perfil
(semente 5) intacto, as duas contagens globais por organizacao intactas, lock
antigo por organizacao ausente.

- Coluna `publication_rate_limit_settings.dispatch_lock_shards`, default 8,
  `check between 1 and 64`. Ajustavel por UPDATE, sem migration nem deploy.
  `1` reproduz o lock unico — e a reversao.
- A aritmetica do balde virou funcao propria,
  `publication_dispatch_lock_bucket(uuid, integer)`, para o teste validar o
  mesmo codigo que roda em producao e nao uma copia. `immutable`, sem
  `set search_path`, corpo de expressao unica — inlineavel, pela licao da 357.
- Ordem de locks preservada: balde primeiro, perfil depois.

### Etapa 9 — verificacao estatica (feita)

`npx tsc --noEmit` exit 0. `npm test` 416 passando, 0 falhas.

### Etapa 10 — aplicacao (feita, na segunda tentativa)

**A primeira tentativa abortou, e o defeito era do teste.** O teste de
distribuicao acusou `menor balde 10000, maior balde 10000`: os 10.000 perfis num
balde so. Causa: `cross join lateral (select gen_random_uuid())` nao referencia a
linha externa, entao o planner avalia UMA vez e reusa o mesmo UUID em todas as
linhas. Os testes 1, 2 e 3 passaram assim mesmo — um UUID repetido nao viola
nenhum deles. So o de distribuicao pegou.

Trocado por `md5(serie.n::text)::uuid`: varia por linha e o teste fica
reproduzivel. Segunda tentativa aplicou com os quatro testes passando.

Nada ficou pela metade na primeira tentativa: a migration e transacional, e
`add column if not exists` + `create or replace` tornam o reenvio idempotente de
qualquer forma.

Aplicada as 01:0x UTC com 87 vencidos e **0 em voo** — nenhuma transacao de
despacho no meio da troca, que era a mitigacao do achado nº 4 da revisao.

### Etapas 12-14 (feitas)

12. Commit `c500892`.
13. Mapa de controles atualizado: a regra da 3-A deixou de apontar para um
    pendente, o fecho da 3-B registra o que foi feito e por que a cota nao foi
    dividida, e `dispatch_lock_shards` entrou na tabela "No BANCO, nao em env".
14. A tarefa das 07:30 foi reescrita. A premissa antiga (teto 1200, lock unico)
    descrevia um mundo que nao existe mais; agora ela mede o fatiamento, tem o
    incidente no contexto, a linha de base do log em 112.934, e o
    `esperaPorSlot` como sinal principal contra os 5.653 ms medidos. A tarefa
    das 21:35 foi arquivada.

### Etapa 11 — validacao (PARCIAL, e e importante dizer isso)

Imediatamente apos aplicar:

| metrica | valor |
|---|---:|
| erros novos no log do worker | **0** (congelado em 112.934) |
| `authenticator` | **18** (teto 41) |
| `esperaPorSlot` p90 | 1 ms |

**Isto ainda nao valida o fatiamento.** Os ciclos tinham 11-12 itens; com esse
volume o lock nao seria disputado nem antes da mudanca. O que estes numeros
mostram e ausencia de regressao e que o DDL nao repetiu o desastre de cache de
schema — nao que a contencao foi dividida.

A validacao de verdade e uma onda grande. A das 07:00 (1.106 itens) e o teste
natural; se o usuario agendar uma fila antes disso, serve tambem. O sinal a
observar e `esperaPorSlot` p90 continuar em milissegundos com centenas de itens
por ciclo, em vez dos 5.653 ms medidos durante o incidente.


### Etapa 4 — infraestrutura de teste (feita)

Existe suíte pgTAP em `supabase/tests/` (dezenas de arquivos `*.test.sql`), mas
ela roda contra o Supabase local e **o Docker não está rodando nesta máquina**
(`failed to connect to the docker API`). Subir o stack local só para isto, com
produção recém-recuperada, troca risco pequeno por demora grande — e o `npm test`
do repositório não cobre SQL (é `node --test lib/**/*.test.ts`).

Decisão: validar as invariantes num bloco `do $$ ... $$` dentro da própria
migration. Como a migration roda em transação, um `raise exception` ali aborta
tudo e nada é aplicado pela metade. Cobre justamente o ponto de risco real
identificado na revisão — a aritmética de sinal do módulo (achado nº 1).

## Decisões tomadas e não tomadas

- **Não vou baixar `STAGED_DISPATCH_CONCURRENCY` de 64 no mesmo movimento.** Com
  o lock fatiado em 8 a contenção por balde já cai para ~8 esperas em vez de 64,
  que era o objetivo da redução. Mexer nos dois ao mesmo tempo impediria saber
  qual resolveu — e a seção 3-A do mapa de controles registra que foi exatamente
  esse erro de método que custou 3.315 publicações. Fica como segunda alavanca.
- **Não vou subir o teto de volta para 1200.** O fatiamento remove a contenção,
  não valida o teto dobrado. São experimentos separados.
