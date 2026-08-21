# Programação em massa — baseline da Fase 0

Data da verificação: 13/08/2026.

## Objetivo

Registrar o comportamento que precisa permanecer estável antes das mudanças de domínio, banco, worker e interface previstas no plano de programação em massa.

Esta fase não implementa o novo modo e não altera regras de produção.

## Baseline funcional de `/postagem`

### 1. Postagem imediata para perfil único

Fluxo atual:

1. selecionar um perfil no campo de destino;
2. manter **Agora** selecionado;
3. escolher formato e mídia no compositor;
4. preencher legenda, se necessário;
5. confirmar a revisão;
6. usar **Adicionar à fila imediata**.

Resultado protegido:

- os itens são enviados com execução imediata;
- perfil único não envia `groupId` operacional;
- a API exige perfil, formato e mídia válidos;
- a fila operacional continua sendo o local de acompanhamento.

Referências: [`PublishingClient()`](../app/postagem/publishing-client.tsx:115), [`submit()`](../app/postagem/publishing-client.tsx:188) e [`makeDraftItems()`](../app/postagem/group-composer-next.tsx:141).

### 2. Postagem programada para perfil único

Fluxo atual:

1. selecionar um perfil;
2. selecionar **Programar**;
3. escolher data única ou horários recorrentes;
4. escolher mídia e legenda;
5. confirmar a revisão;
6. usar **Agendar publicações**.

Resultado protegido:

- data única exige instante futuro;
- formato simples com data única usa uma mídia;
- recorrência procura próximos horários-base livres;
- conflitos ativos do perfil são considerados;
- horários-base recorrentes são convertidos pelo servidor em reservas dentro da janela correspondente.

Referências: [`buildRecurringSchedule()`](../lib/publications/composer.ts:266), [`buildRepeatedPublicationSchedule()`](../lib/publications/composer.ts:302) e [`POST()`](../app/api/publications/route.ts:272).

### 3. Composição para grupo

Fluxo atual:

1. selecionar um grupo como destino;
2. marcar os perfis online desejados;
3. configurar ou distribuir mídias entre os perfis;
4. revisar os planos individuais;
5. enviar a run.

Resultado protegido:

- somente perfis disponíveis podem ser marcados;
- cada perfil selecionado mantém seu próprio plano;
- distribuição sequencial atual reparte as mídias entre os perfis;
- distribuição aleatória atual embaralha antes de repartir;
- regras de mídia reutilizável e uso único permanecem válidas;
- a nova programação em massa futura não pode alterar esse comportamento tradicional.

Referências: [`GroupComposerNext()`](../app/postagem/group-composer-next.tsx:451), [`distributeMediaBetweenProfiles()`](../lib/publications/composer.ts:201) e [`applyBulk()`](../app/postagem/group-composer-next.tsx:907).

### 4. Repetição recorrente atual

Resultado protegido:

- quantidade de slots é horários normalizados multiplicados por dias;
- dias ficam entre 1 e 365;
- horários são opções de dez em dez minutos;
- slots passados são ignorados;
- blocos ocupados são pulados;
- mídias repetem em ordem circular quando há mais slots que mídias;
- a repetição atual é baseada em horários por dia e permanece separada da futura janela móvel por intervalo.

Referências: [`normalizeDailyTimes()`](../lib/publications/composer.ts:185), [`normalizeRecurringRepeatDays()`](../lib/publications/composer.ts:189) e [`recurringPublicationSlotCount()`](../lib/publications/composer.ts:197).

## Regras transversais protegidas por testes

- legenda compartilhada preserva quebras de linha e Unicode;
- limite de legenda permanece em 2.200 unidades UTF-16;
- Imagem aceita imagem;
- Reel aceita vídeo;
- Story aceita imagem ou vídeo, uma mídia por publicação;
- Carrossel exige de duas a dez mídias;
- datas locais são interpretadas em `America/Sao_Paulo`;
- distribuição tradicional sequencial e aleatória não muda durante a criação do modo novo.

Cobertura adicionada em [`composer.test.ts`](../lib/publications/composer.test.ts).

## Estado das migrations

- última migration local: [`083_queue_reference_dashboard_and_archiving.sql`](../supabase/migrations/083_queue_reference_dashboard_and_archiving.sql);
- `supabase migration list` confirmou migrations locais e remotas alinhadas de 001 até 083;
- a primeira migration da programação em massa deverá usar o próximo número disponível, sem reescrever migrations aplicadas.

## Estado dos workers

O arquivo de implantação [`env.worker.deploy`](../.env.worker.deploy) foi inspecionado sem imprimir segredos.

Configuração registrada:

- worker de publicação: modo `observe`, dry-run habilitado, limite 5, poll de 5 segundos;
- worker de geração: modo `observe`, dry-run habilitado, limite de job 1 e limite de chunk 1;
- URL do Supabase e chave de service role estão configuradas;
- `TOKEN_ENCRYPTION_KEY` foi adicionada ao arquivo local de implantação, validada como Base64 de 32 bytes e mantida sem exposição em logs;
- o arquivo local de implantação foi incluído no [`.gitignore`](../.gitignore) para impedir novos commits acidentais de segredos.

Conclusão operacional corrigida após consulta ao runbook: [`vps-worker-runbook.md`](vps-worker-runbook.md) registra o worker de publicação em `direct`/dry-run desativado e o worker de geração em `plan`/dry-run desativado, ambos no PM2 da VPS. O arquivo local de implantação conserva valores seguros de `observe` e não deve ser usado para inferir o estado atual dos processos remotos. Em um próximo deploy de configuração, a chave deve ser transferida de forma segura para `/opt/athena-worker/.env.worker`, sem impressão do valor, e os modos efetivos da VPS devem ser preservados.

## Comandos de validação da Fase 0

Executar na raiz do projeto:

- `npm test`;
- `npx tsc --noEmit`;
- `npm run build`.

Resultados de 13/08/2026:

- `npm test`: aprovado, 27 testes, 27 aprovados e nenhuma falha;
- `npx tsc --noEmit`: aprovado sem diagnósticos;
- `npm run build`: aprovado com compilação de produção completa;
- avisos preexistentes do build: `viewport` e `themeColor` ainda estão no export de metadata de `_not-found`, `/login` e `/onboarding`; não bloqueiam esta fase e não foram alterados por ela;
- aviso preexistente dos testes: o pacote não declara `type: module`, então o Node refaz o parse dos testes TypeScript como ES modules; não houve falha.

## Critério de encerramento

A Fase 0 termina quando:

- este baseline está versionado;
- os testes de regressão passam;
- TypeScript passa;
- o build passa;
- migrations local/remota estão confirmadas;
- o estado não efetivo dos workers está explicitamente documentado, sem afirmar uma implantação que não foi comprovada.
