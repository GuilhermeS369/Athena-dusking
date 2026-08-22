# Plano aprovado — módulo X/Twitter via Zernio

> Status: aprovado para execução em 22/08/2026.
>
> Regra de continuidade: o estado executado fica em `docs/x-twitter/README.md`, `STATE.json` e `EXECUTION_LOG.md`. Este arquivo registra o desenho aprovado e não deve ser reescrito silenciosamente durante a implementação.

## 1. Resultado esperado e invariantes

Criar um módulo X/Twitter completo e independente, conectado exclusivamente pela Zernio. O Instagram pode servir de referência visual e operacional, mas não compartilhará tabelas, filas, RPCs, claims, heartbeats, workers, circuit breakers, saldos ou processos PM2 com o X.

Invariantes:

1. Não modificar o comportamento das rotas, workers, filas ou dados atuais do Instagram.
2. Alterações compartilhadas ficam limitadas à navegação e a adaptadores neutros do Dashboard.
3. Tabelas, buckets, páginas, APIs e workers do X usam prefixos e namespaces próprios.
4. Valores financeiros são inteiros em micros de dólar; ponto flutuante é proibido.
5. Toda operação externa faturável passa por reserva, ledger e idempotência.
6. Resultado externo desconhecido nunca é repetido cegamente.
7. Migrações são aditivas e o rollout começa desligado por feature flag.
8. Cada etapa é documentada e versionada antes da próxima.
9. Secrets, payloads pessoais e URLs assinadas nunca entram em Git ou documentação.

## 2. Produto e navegação

O menu lateral terá seções expansíveis:

- Instagram: Postagem, Fila, Galeria, Perfis, Grupos, Agenda, Zernio e Logs.
- X/Twitter: Análises, Postagem, Fila, Galeria, Perfis, Grupos, Agenda, Zernio e Logs.

Dashboard e Importação em massa continuam gerais. As novas páginas usam `/x/*`. A página `/x/postagem` contém somente Postagem em massa, sem os modos individuais Agora e Programar.

Papéis:

- viewer: leitura;
- operator: criar, confirmar, cancelar e repetir ações permitidas, executar análises e resolver ocorrências financeiras individuais com justificativa;
- admin: permissões do operator, gestão de chaves, transferências, rate cards e regras financeiras.

Fora da primeira versão: DMs, replies, quotes, follows, reposts, bookmarks, threads, polls, artigos e edição/exclusão remota.

## 3. Postagem em massa

Formatos suportados:

- texto sem mídia;
- 1 a 4 imagens JPEG/PNG/WebP, até 5 MB cada;
- um GIF, até 15 MB;
- um vídeo MP4/MOV, até 512 MB e 140 segundos.

Um programa usa um único tipo de mídia. Conjuntos de imagens têm de 1 a 4 arquivos e pertencem somente ao programa. GIFs e vídeos alternativos são conjuntos de um arquivo. Upload de vídeo é direto/retomável para o Storage e nunca usa um buffer integral no Next.js ou worker.

Variações:

- aceitar um ou vários textos;
- produzir o produto cartesiano texto × conjunto de mídia antes de repetir;
- rotação determinística com deslocamento inicial alternado por perfil;
- congelar o par final ao confirmar;
- nunca alterar texto automaticamente para contornar duplicidade.

Validação conforme [Zernio Twitter/X](https://docs.zernio.com/platforms/twitter):

- Free: 280 caracteres;
- Premium: 25.000 somente quando o validador da conta confirmar;
- fallback: 280;
- URL conta 23 caracteres;
- emoji conta 2;
- conteúdo duplicado ou semelhante pode ser rejeitado.

Agendamento:

- intervalo mínimo de 1 minuto e duração máxima de 90 dias;
- horário fixo diário em `America/Sao_Paulo`;
- após HTTP 429, tentar em `max(Retry-After, 4 minutos)`, sem escalada exponencial adicional;
- no máximo uma chamada ativa por perfil.

## 4. Carteira, ledger e reservas

Cada `userId` estável retornado por `/v1/auth/verify` recebe uma única concessão global de US$ 12,00. Rotação de API key ou recadastro não cria nova concessão. A identidade só pode pertencer a uma organização por vez; transferência é administrativa, auditada e preserva o saldo.

Rate card inicial em micros:

| Categoria | Micros | Valor |
|---|---:|---:|
| leitura de post | 5.000 | US$ 0,005 |
| leitura de usuário/follower/ação de artigo | 10.000 | US$ 0,010 |
| criação de post ou DM | 15.000 | US$ 0,015 |
| criação de post com `http://` ou `https://` | 200.000 | US$ 0,200 total |

O saldo Athena é local e nunca é sobrescrito pelo billing da Zernio.

```text
saldo_contábil = concessões + créditos - débitos liquidados
saldo_disponível = saldo_contábil - reservas abertas
```

Ledger imutável e reservas registram organização, identidade, conexão, rate card, categoria, valor, origem, recurso, idempotency key, autor e timestamps.

### Revisão e confirmação

Revisar é read-only: valida conteúdo, mídia, perfis, agenda, capacidade e preço; retorna token, versão do rate card, snapshot da carteira, totais solicitados/financiados/não financiados, custos e distribuição. Não cria items, reservas ou débitos.

Confirmar:

1. bloqueia a carteira;
2. valida token, rate card e snapshot;
3. responde `409` se o estado mudou;
4. reserva apenas o financiável;
5. materializa itens em chunks;
6. registra o excedente de forma compacta por perfil/quantidade/intervalo.

Saldo baixo usa round-robin determinístico entre perfis. Um slot com URL que não caiba não impede procurar slots sem URL. Excedentes ficam terminais como `Sem saldo neste programa`, sem aguardar recarga e sem retomada automática.

### Cancelamento e resultados

Cancelamento de item, lote, programa, perfil ou grupo é transacional e idempotente:

- item não iniciado libera reserva imediatamente;
- retry confirmado não cobrado libera ao cancelar;
- item já enviado mantém hold até resultado/reconciliação;
- repetição do cancelamento não cria crédito.

| Resultado | Tratamento |
|---|---|
| erro local antes da chamada | liberar |
| falha terminal confirmada sem cobrança | liberar |
| 429 confirmado não cobrado | manter para retry; liberar ao cancelar |
| aceito/processando | manter hold |
| publicado ou `existingPost` | liquidar débito |
| timeout/5xx/resultado incerto | `outcome_unknown`, manter hold, sem retry cego |

## 5. Dados, APIs e isolamento

Criar tabelas `twitter_*` para conexões, identidades, perfis, épocas, grupos, assets, programas, items, tentativas, carteiras, grants, rate cards, reservas, ledger, regras, analytics, eventos e heartbeats. Criar bucket `twitter-media` com RLS organizacional. Nenhuma FK aponta para estruturas operacionais do Instagram.

Namespaces:

- páginas: `/x/*`;
- APIs: `/api/x/*`;
- integração: `/api/x/integrations/zernio/*`;
- internos: `/api/internal/twitter-*`.

Contratos:

- review retorna `reviewToken`, snapshot/versionamento e totais;
- confirm exige `reviewToken` e idempotency key;
- claims retornam somente `twitter_*`;
- resultados exigem attempt ID e idempotency key;
- cancelamentos retornam items afetados, reservas liberadas e holds pendentes;
- analytics usa quote/confirm separado.

RLS cobre toda tabela organizacional. RPCs financeiras verificam organização e papel explicitamente.

## 6. Conexão, perfis e logs

Usar ID imutável do X, nunca username, como identidade do perfil. `twitter_profiles` é estável e `twitter_profile_connection_epochs` registra as épocas. Reconectar em outra conexão cria época para novos programas; não reativa filas ou grupos antigos. Reautenticar a mesma conexão pode preservar a época.

Excluir conexão:

- impede novos programas;
- cancela fila futura e libera reservas não usadas;
- soft-delete dos perfis;
- preserva ledger, posts, logs e histórico;
- nunca transfere fila para outra Zernio.

`/x/logs` mostra perfil, conexão, preços, fases, HTTP/provider code, request/post IDs, erro sanitizado, timeline e vínculos financeiros. Ocorrências incertas permitem reconciliar ou confirmar resultado, com justificativa e evento imutável. Admin pode criar regras futuras exatas por fase + HTTP + código estável; regras não retroagem, não autoaprendem e apenas são desativadas.

## 7. Analytics manual

Entra depois da publicação estável. `/x/analises` filtra perfis, grupos, período e tipo, faz quote e exige confirmação.

- post read: US$ 0,005 por post;
- user/follower read: US$ 0,010 por perfil;
- nenhuma atualização automática;
- Dashboard lê snapshots locais;
- `analytics=false` e `inbox=false` por padrão;
- `TWITTER_ANALYTICS_ENABLED` só é ativado após canário sem cobrança autônoma.

```text
capacidade_analytics = saldo_disponível - reservas_publicação - US$ 5,00
```

Abaixo do piso, analytics desabilita e publicação continua. Sucesso parcial liquida confirmados; falhas confirmadas liberam; desconhecidos mantêm hold.

## 8. Workers e rollout

Processos separados:

- `athena-twitter-publication-worker`;
- `athena-twitter-generation-worker`;
- `athena-twitter-zernio-sync-worker`;
- `athena-twitter-analytics-worker`;
- `athena-twitter-webhook-reconcile-worker`.

Cada processo terá secret, heartbeat, claim, circuit breaker, métricas, feature flag, kill switch e concorrência inicial 1 próprios. Workers X não importam lógica operacional Instagram-específica.

Ordem de rollout:

1. migrações aditivas;
2. aplicação Vercel desligada por flag;
3. workers instalados em dry-run;
4. shadow mode;
5. canário por organização;
6. ativação progressiva;
7. fallback Vercel somente após shadow, quando heartbeat VPS estiver stale.

Primeiros posts reais: texto sem URL, uma imagem, 2–4 imagens, GIF, vídeo e URL por último.

## 9. Fases e gates

0. Baseline: consolidar Analytics 210–222, documentar ambientes, testes e rollback.
1. Fundação: feature flags, navegação, schemas, RLS, bucket, carteira e ledger.
2. Zernio/perfis: identidade, conexão, health, capacidades e épocas.
3. Conteúdo: galeria, grupos, agenda e upload.
4. Bulk: composer, review, confirm, reserva parcial e excedente.
5. Operação: fila, workers, logs e shadow.
6. Canário: publicação real na ordem definida.
7. Analytics: manual, piso de US$ 5 e snapshots.
8. Rollout: ativação progressiva, monitoramento e handoff final.

Cada gate exige documentação/`STATE.json`, `git diff --check`, testes, verificação de ambientes, rollback e commit do checkpoint.

## 10. Aceite final

- zero acesso cruzado entre filas/workers X e Instagram;
- nenhum débito sem ledger;
- nenhuma devolução duplicada;
- nenhuma criação acima do saldo;
- nenhum retry cego após resultado incerto;
- RLS e papéis aprovados;
- regressão Instagram verde;
- outra conta GPT continua somente pela documentação versionada.
