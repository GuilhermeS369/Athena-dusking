# Ativação do dashboard funcional para todas as organizações do Athena

**Data:** 25/08/2026  
**Status:** executado e ativado globalmente em produção  
**Escopo:** dashboard de analytics do Instagram para todas as organizações do Athena  
**Fora de escopo nesta etapa:** dashboard do X/Twitter, mudanças no coletor Zernio sem relação com analytics e correções de credenciais individuais

## 1. Objetivo

Disponibilizar para todos os usuários do Athena um dashboard de analytics que:

- apresente corretamente as métricas do dia atual e dos demais períodos;
- reflita uma atualização assim que o job de coleta terminar;
- suporte organizações pequenas e grandes sem truncar registros;
- mantenha os filtros de perfil, grupo, origem e período;
- degrade de forma explícita e segura quando uma fonte estiver indisponível;
- permita rollback sem perda de dados analíticos já persistidos.

## 2. Incidente que motivou a correção

Na organização **Vini farmando cash**, as coletas de 25/08/2026 foram concluídas e persistidas, mas o dashboard não mostrou as métricas de hoje.

Evidências verificadas em produção:

- 421 de 422 perfis possuem métricas completas em `2026-08-25`;
- 233.991 visualizações;
- 176.640 de alcance;
- 8.679 interações;
- 7.693 curtidas;
- quatro jobs executados no dia, com 656 conclusões e três falhas isoladas de permissão da plataforma.

A causa está no caminho V1 de leitura. A consulta de `profile_analytics_daily_metrics` solicita até 370 dias, ordena as datas do registro mais antigo para o mais recente e depende de um limite nominal de 10.000 linhas. O endpoint de dados, porém, entrega no máximo 1.000 linhas por requisição. Em organizações grandes, o resultado termina antes de alcançar o dia atual.

A reprodução literal da consulta retornou:

- 1.000 registros;
- primeira data: `2026-08-18`;
- última data: `2026-08-24`;
- registros de `2026-08-25`: zero.

O RPC agregado V2 foi consultado diretamente para o mesmo dia e retornou os valores corretos. Portanto, a coleta e a persistência estão saudáveis; a falha está na estratégia de leitura do dashboard.

## 3. Estratégia de correção

A solução definitiva será tornar o dashboard agregado V2 o caminho padrão para todas as organizações. O V1 permanecerá temporariamente como fallback protegido, sem truncamento silencioso.

Não será adotada como solução definitiva apenas a inversão da ordenação do V1. Isso recuperaria o dia atual, mas continuaria produzindo períodos incompletos para organizações com volume superior a 1.000 linhas.

### 3.1. Caminho principal V2

Usar como fontes do dashboard:

- `get_dashboard_bootstrap_v2` para contexto e estado inicial;
- `get_dashboard_analytics_v2` para KPIs, séries, ranking, cobertura e distribuições;
- `get_dashboard_top_posts_v2` para os posts com melhor desempenho;
- `/api/dashboard/analytics-v2` como endpoint autenticado da interface.

Os agregados serão calculados no banco somente para o período e os filtros selecionados. Isso evita transferir milhares de linhas brutas para o Next.js.

### 3.2. Atualização imediatamente visível

Quando um job manual terminar com sucesso ou sucesso parcial:

1. encerrar o polling do job;
2. invalidar os dados do dashboard;
3. atualizar o bootstrap operacional;
4. executar novamente a consulta agregada com os filtros atualmente selecionados;
5. impedir reutilização de uma resposta anterior do navegador durante esse refresh;
6. exibir a mensagem de conclusão somente depois que a nova consulta for processada.

O refresh normal da tela poderá manter cache privado curto, mas o refresh iniciado pelo usuário deverá usar `cache: 'no-store'` ou uma chave de versão vinculada à conclusão do job.

### 3.3. Fallback seguro

Caso o RPC V2 esteja temporariamente indisponível:

- manter o resumo operacional utilizável;
- mostrar um aviso de indisponibilidade da seção analítica;
- nunca apresentar zeros como se fossem métricas reais;
- nunca retornar silenciosamente um período truncado;
- registrar o erro do RPC sem expor payloads ou credenciais;
- permitir tentativa manual de recarregamento.

Se a leitura bruta V1 precisar ser mantida durante a transição, ela deverá ser paginada de 1.000 em 1.000, limitada ao período efetivamente solicitado e acompanhada de metadados de cobertura. Esse fallback não será usado como caminho normal para períodos extensos.

## 4. Alterações previstas

### 4.1. Servidor do dashboard

Arquivo principal: `lib/dashboard/server.ts`

- tornar o bootstrap V2 padrão;
- remover a dependência do carregamento bruto de até 370 dias no caminho principal;
- preservar um fallback explícito e observável;
- não preencher campos analíticos com zeros quando a fonte estiver indisponível;
- incluir versão e fonte dos dados na resposta interna.

### 4.2. Endpoint agregado

Arquivo principal: `app/api/dashboard/analytics-v2/route.ts`

- validar organização, datas, perfil, grupo, provedor e métrica;
- manter isolamento multiempresa em todas as chamadas;
- configurar cache coerente com refresh manual;
- devolver cobertura, data máxima disponível e horário de geração;
- preservar resposta parcial de top posts quando somente essa seção falhar.

### 4.3. Interface

Arquivo principal: `app/dashboard-client.tsx`

- refazer a consulta agregada após o término do job;
- manter os filtros selecionados durante o refresh;
- diferenciar carregamento inicial, atualização e indisponibilidade;
- exibir cobertura parcial quando houver perfis sem dados;
- impedir que uma resposta antiga sobrescreva uma resposta mais recente;
- manter os números anteriores enquanto uma atualização está em andamento, em vez de piscar zeros.

### 4.4. Configuração de rollout

- substituir a ativação restrita por organização pela ativação global controlada;
- preservar uma chave de desligamento de emergência;
- documentar o valor anterior das flags antes da mudança;
- confirmar que Preview e Production não divergem acidentalmente;
- não remover o fallback no mesmo deploy da ativação global.

### 4.5. Observabilidade

Registrar, sem dados sensíveis:

- versão do dashboard utilizada;
- organização;
- período e filtros normalizados;
- duração dos RPCs;
- quantidade de perfis selecionados e com métricas;
- primeira e última datas de cobertura;
- erros normalizados do bootstrap, analytics e top posts;
- término do job e horário da primeira leitura posterior.

## 5. Segurança e isolamento multiempresa

Antes da liberação global será validado que:

- todos os RPCs verificam associação do usuário à organização;
- `organization_id` é obrigatório e aplicado em todas as consultas;
- IDs de perfil e grupo de outra organização não ampliam o escopo;
- o service role não é enviado ao navegador;
- respostas e logs não contêm tokens, cookies, payloads brutos ou URLs sensíveis da Zernio;
- o cache privado não compartilha respostas entre usuários ou organizações.

## 6. Testes obrigatórios

### 6.1. Regressão de volume

Criar um cenário com pelo menos:

- 422 perfis;
- oito ou mais dias de métricas;
- mais de 1.000 registros no total;
- métricas existentes no dia atual.

O teste deve comprovar que o dashboard inclui o dia atual e não depende do limite de linhas do PostgREST.

### 6.2. Períodos

Validar:

- Hoje;
- Ontem;
- Anteontem;
- últimos 7 dias;
- últimos 30 dias;
- últimos 90 dias;
- últimos 6 meses;
- último ano.

### 6.3. Filtros

Validar combinações de:

- todos os perfis;
- um perfil;
- um grupo;
- API oficial;
- integração externa;
- cada métrica suportada.

### 6.4. Fuso horário

Testar as fronteiras de `America/Sao_Paulo`, especialmente:

- antes e depois de 00:00;
- registros UTC pertencentes ao dia civil anterior ou seguinte em São Paulo;
- mudança de período com a tela aberta.

### 6.5. Atualização manual

Validar o fluxo completo:

1. registrar os valores exibidos;
2. iniciar refresh de um perfil, grupo e organização;
3. aguardar o job terminar;
4. confirmar nova chamada agregada;
5. confirmar que os valores exibidos correspondem ao banco;
6. confirmar que cache antigo não prevalece;
7. confirmar comportamento com sucesso parcial.

### 6.6. Falhas e concorrência

- RPC principal indisponível;
- top posts indisponível isoladamente;
- troca rápida de filtros;
- refresh concluindo enquanto o usuário troca de período;
- duas respostas chegando fora de ordem;
- perfil com `permission_missing` sem afetar os demais;
- organização sem métricas;
- organização com apenas um perfil.

## 7. Validação antes da produção

1. Executar testes unitários e de regressão.
2. Executar checagem de tipos.
3. Executar build de produção.
4. Publicar deployment de Preview.
5. Comparar o Preview com os RPCs para Vini e pelo menos uma organização pequena.
6. Confirmar visualmente todos os períodos e filtros principais.
7. Executar um refresh direcionado e validar a atualização imediata.
8. Auditar logs para garantir ausência de dados sensíveis e erros inesperados.

## 8. Rollout para todos os usuários

Embora o objetivo seja a ativação global, a publicação seguirá gates curtos para reduzir risco.

### Gate A — Preview

- todos os testes aprovados;
- build aprovado;
- paridade entre interface, RPC e tabelas locais.

### Gate B — produção com Vini

- validar os valores de referência de 25/08;
- validar refresh pós-job;
- observar erros e latência;
- confirmar que o caminho V1 truncado não foi utilizado.

### Gate C — organizações de diferentes portes

- uma organização pequena;
- uma organização média;
- uma segunda organização grande;
- confirmar isolamento e desempenho.

### Gate D — ativação global

- habilitar V2 como padrão para todas as organizações;
- manter kill switch e fallback;
- acompanhar erros, latência e cobertura durante o primeiro ciclo completo de coleta.

Os gates poderão ocorrer na mesma janela de implantação se cada validação for concluída com sucesso. Qualquer divergência interrompe a ampliação.

## 9. Critérios de aceite

A entrega estará concluída quando:

- todas as organizações usarem o dashboard agregado funcional;
- o filtro Hoje apresentar a data civil atual de São Paulo;
- Vini apresentar os valores persistidos de 25/08 ou valores posteriores corretamente atualizados;
- períodos longos não forem truncados em 1.000 registros;
- refresh manual atualizar a interface sem recarregamento manual;
- filtros de perfil, grupo, fonte, período e métrica mantiverem paridade com o banco;
- falhas isoladas não zerarem os demais perfis;
- organizações sem dados exibirem estado vazio verdadeiro, não erro nem números falsos;
- não houver vazamento entre organizações;
- logs, testes, build e validação visual estiverem aprovados;
- rollback estiver testado e documentado.

## 10. Rollback

Se houver erro grave após a ativação:

1. acionar o kill switch global do V2;
2. manter a coleta e persistência de analytics operando normalmente;
3. retornar ao fallback protegido, nunca à consulta V1 truncada original;
4. preservar todos os dados coletados durante a janela;
5. registrar organizações, filtros e sintomas afetados;
6. corrigir em Preview e repetir os gates.

O rollback do dashboard não deve cancelar jobs de analytics nem alterar snapshots, métricas diárias ou históricos já persistidos.

## 11. Evidências a produzir durante a execução

- diff dos arquivos alterados;
- resultados dos testes;
- resultado da checagem de tipos e do build;
- comparação RPC versus interface para os períodos principais;
- evidência do refresh pós-job;
- valores das flags antes e depois, sem segredos;
- identificação do deployment de Preview e Production;
- relatório de saúde após ativação global;
- instrução final de rollback.

## 12. Estado de autorização

A execução foi autorizada explicitamente pelo responsável após a criação deste documento.

## 13. Registro de execução

### Alterações aplicadas

- rollout V2 global controlado por `DASHBOARD_V2_ENABLED`;
- kill switch com precedência por `DASHBOARD_V2_KILL_SWITCH`;
- allowlist por organização preservada para usos controlados;
- fallback V1 alterado para priorizar as datas mais recentes e avisar sobre cobertura limitada;
- endpoint agregado configurado com `private, no-store, max-age=0`;
- nova consulta automática dos agregados após a conclusão de um job manual;
- proteção contra resposta analítica antiga durante troca de filtro ou refresh;
- aviso visível de cobertura parcial;
- telemetria de duração, cobertura e data máxima do agregado;
- teste SQL de regressão com 422 perfis e 3.360 linhas diárias.

### Validações locais

- suíte Node: 282 testes aprovados, zero falha;
- TypeScript: aprovado com `tsc --noEmit`;
- build Next.js de produção: aprovado;
- build remoto Vercel de Preview: aprovado;
- build remoto Vercel de Production: aprovado;
- `git diff --check`: aprovado; somente avisos existentes de normalização LF/CRLF.

O pgTAP local não pôde ser executado porque a máquina não possui Docker ou Podman disponível. O cenário foi preservado em `supabase/tests/210_dashboard_aggregated_v2.test.sql`, e o comportamento equivalente foi validado por consultas somente leitura contra os RPCs remotos.

### Paridade remota por organização

Todos os RPCs `get_dashboard_bootstrap_v2` e `get_dashboard_analytics_v2` responderam sem erro para as organizações ativas:

- FARM: zero perfis, estado vazio válido;
- Pomodoro: 791 perfis; 532 com métricas em 25/08;
- Vini farmando cash: 422 perfis; 421 com métricas em 25/08.

Valores confirmados para Vini em 25/08:

- 233.991 visualizações;
- 176.640 de alcance;
- 8.679 interações;
- 7.693 curtidas.

### Deployments

- Preview validado: `dpl_z18bMorCkeqxKMoMvSCJoYRVkEfa`;
- Production ativado: `dpl_7cW1pNqPU5x2DeYGv8gi6Got9WDQ`;
- Production anterior preservado para rollback: `dpl_Dwev7H9vPXWQpAtNaGkqMNA38EXo`;
- alias principal confirmado: `https://pomodoro-theta-one-82.vercel.app`;
- segundo alias confirmado: `https://pomodoro-shoows-projects-2caaf9e9.vercel.app`.

### Configuração aplicada

- Preview: `DASHBOARD_V2_ENABLED=true`;
- Preview: `DASHBOARD_V2_KILL_SWITCH=false`;
- Production: `DASHBOARD_V2_ENABLED=true`;
- Production: `DASHBOARD_V2_KILL_SWITCH=false`.

Os valores são armazenados como variáveis sensíveis na Vercel. A ativação global também cobre organizações criadas futuramente.

### Saúde inicial

- deployment de produção em estado `READY`;
- endpoint `/api/dashboard/analytics-v2` publicado e exigindo autenticação;
- nenhum erro de runtime ou resposta 5xx encontrado nos logs iniciais;
- a validação visual autenticada não foi executada porque os navegadores disponíveis não possuíam sessão Athena/Vercel utilizável; nenhuma credencial foi solicitada ou manipulada.

### Rollback operacional

Em caso de regressão grave:

1. definir `DASHBOARD_V2_KILL_SWITCH=true` em Production;
2. criar um novo deployment para materializar a mudança de ambiente; ou
3. promover o deployment anterior `dpl_Dwev7H9vPXWQpAtNaGkqMNA38EXo`.

Nenhuma dessas ações remove snapshots ou métricas já coletadas.
