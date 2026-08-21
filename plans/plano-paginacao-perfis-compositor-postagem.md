# Plano — carregamento progressivo de perfis no compositor de postagem

## Objetivo

Impedir que a caixa **Perfis do grupo** renderize centenas de contas de uma vez quando um grupo tiver muitos perfis, sem alterar a semântica global da seleção.

Comportamento definido:

- exibir inicialmente no máximo 20 perfis;
- o botão **Ver mais** acrescenta até 20 perfis à lista a cada clique: 20 → 40 → 60;
- **Selecionar todos** seleciona todos os perfis disponíveis do grupo, inclusive os que ainda não estão visíveis;
- **Limpar** remove toda a seleção, inclusive perfis que não estão visíveis;
- os cards de configuração dos perfis selecionados continuam funcionando como hoje;
- ao trocar de grupo, a caixa volta a mostrar somente os primeiros 20 perfis.

## Diagnóstico do fluxo atual

### Origem dos dados

A página [`PublishingPageContent()`](../app/(painel)/postagem/page.tsx:79) busca todos os perfis ativos da organização, em ordem de usuário, e todos os grupos com seus respectivos IDs de membros. Esses dados são repassados ao cliente por [`PublishingClient()`](../app/postagem/publishing-client.tsx:115).

No compositor, [`GroupComposerNext()`](../app/postagem/group-composer-next.tsx:451) cria a lista `members` filtrando os perfis da organização pelos IDs vinculados ao grupo. Portanto, o cliente já possui a coleção completa necessária para uma seleção global correta.

### Gargalo visual

O seletor atual executa um `map` sobre todos os membros em [`group-composer-next.tsx`](../app/postagem/group-composer-next.tsx:1010). Com 300 contas, os 300 cards são inseridos no DOM de uma vez, aumentando muito a altura da caixa e o custo da primeira renderização.

O botão atual **Selecionar todos** já opera sobre a coleção completa `members`, excluindo perfis indisponíveis, em [`group-composer-next.tsx`](../app/postagem/group-composer-next.tsx:999). Essa semântica deve ser preservada e explicitamente protegida da paginação visual.

### Escopo real da melhoria

Esta mudança reduz os elementos renderizados **na caixa de seleção**, mas não reduz a consulta inicial de perfis nem a quantidade de cards de configuração criados abaixo quando o usuário selecionar muitos perfis. Isso é intencional para esta entrega: foi definido que os cards dos perfis selecionados devem continuar como estão.

Uma paginação de servidor não é necessária nesta etapa e, isoladamente, complicaria o requisito de selecionar todos. Como os dados completos já alimentam outras partes do compositor, a solução de menor risco é limitar somente a projeção visual da lista.

## Arquitetura proposta

### 1. Constante de tamanho do lote

Adicionar uma constante no módulo [`group-composer-next.tsx`](../app/postagem/group-composer-next.tsx), próxima aos demais tipos e constantes:

- `PROFILE_SELECTOR_PAGE_SIZE = 20`.

O valor não deve ficar repetido em eventos e textos, evitando divergência futura.

### 2. Estado exclusivamente visual

Adicionar em [`GroupComposerNext()`](../app/postagem/group-composer-next.tsx:451) um estado como `visibleProfileCount`, iniciado com `PROFILE_SELECTOR_PAGE_SIZE`.

Esse estado controla apenas quantos cards aparecem na caixa. Ele não pode ser usado para calcular:

- IDs selecionados;
- total de membros;
- destinos em lote;
- planos por perfil;
- itens enviados para publicação.

Essa separação é a principal garantia contra o erro de **Selecionar todos** passar a selecionar apenas os 20 visíveis.

### 3. Derivações memoizadas

Derivar a partir de `members`:

- `visibleMembers = members.slice(0, visibleProfileCount)`;
- `remainingProfileCount = Math.max(0, members.length - visibleMembers.length)`;
- `hasMoreProfiles = remainingProfileCount > 0`;
- `selectableProfileIds`, contendo todos os IDs cujo status seja publicável;
- um `Set` dos IDs selecionados para consultas rápidas durante a renderização.

O `Set` evita executar repetidamente buscas lineares em `profileIds` para cada card e para cada perfil ativo. Com centenas de contas, essa pequena alteração mantém o cálculo previsível sem mudar o formato do estado existente.

O array `profileIds` deve continuar sendo a fonte de verdade porque já integra os planos, destinos e itens emitidos pelo compositor.

### 4. Renderização progressiva

Trocar apenas a origem do `map` da caixa:

- de `members.map(...)`;
- para `visibleMembers.map(...)`.

Não aplicar o recorte a `activeProfiles`. Perfis selecionados e ainda não visíveis precisam continuar presentes nos cards de configuração e na geração das postagens.

### 5. Ação Ver mais

Renderizar um rodapé abaixo da grade quando `hasMoreProfiles` for verdadeiro.

Ao clicar:

- atualizar `visibleProfileCount` com `Math.min(current + PROFILE_SELECTOR_PAGE_SIZE, members.length)`;
- manter `profileIds` intacto;
- manter planos e configurações já preenchidos intactos;
- desabilitar a ação quando o compositor estiver desabilitado;
- ocultar o botão quando todos os membros já estiverem visíveis.

Texto recomendado:

- informação: **Exibindo 20 de 300 perfis**;
- botão: **Ver mais 20** enquanto houver pelo menos 20 restantes;
- no último lote: **Ver mais 7**;
- depois do último clique, manter somente **Exibindo 300 de 300 perfis** e remover o botão.

### 6. Seleção global

O evento de **Selecionar todos** deve usar `selectableProfileIds`, calculado sobre a coleção completa `members`, nunca sobre `visibleMembers`.

Regras:

- selecionar todos os perfis com status aceito pelo fluxo atual;
- não selecionar perfis indisponíveis;
- não abrir automaticamente todos os lotes do seletor;
- manter o contador do cabeçalho global, por exemplo **300 de 300**;
- permitir que **Limpar** zere toda a seleção sem alterar a quantidade de perfis visíveis.

Exemplo esperado com 300 membros:

1. a caixa mostra 20 perfis;
2. o usuário clica em **Selecionar todos**;
3. todos os perfis disponíveis são selecionados;
4. a caixa continua mostrando 20 cards;
5. o contador reflete a seleção total;
6. ao clicar em **Ver mais 20**, os próximos cards aparecem já marcados.

### 7. Reset ao trocar de destino

No efeito que já limpa o estado quando muda `group.id` ou o perfil único, em [`group-composer-next.tsx`](../app/postagem/group-composer-next.tsx:549), também restaurar `visibleProfileCount` para 20.

Isso evita abrir um grupo novo já expandido até 300 porque o grupo anterior havia sido totalmente exibido.

Não resetar o limite ao clicar em **Selecionar todos**, **Limpar** ou alternar um checkbox; essas ações não representam mudança de grupo.

### 8. CSS e responsividade

Adicionar classes locais em [`publication-composer.module.css`](../app/postagem/publication-composer.module.css) para o rodapé da lista e o botão **Ver mais**.

Diretrizes:

- preservar o grid responsivo existente de `.profileChoiceList`;
- separar visualmente o rodapé sem criar outro painel pesado;
- alinhar contagem e botão nas telas largas;
- empilhar ou permitir quebra em telas pequenas;
- usar as variáveis de cor, borda e superfície já existentes;
- manter área clicável mínima coerente com os demais botões;
- não criar altura fixa nem rolagem interna na caixa, pois o comportamento aprovado é expansão acumulativa.

### 9. Acessibilidade

Aplicar no rodapé:

- texto de progresso compreensível sem depender apenas da posição visual;
- `aria-live="polite"` na mensagem **Exibindo X de Y perfis**;
- `aria-controls` no botão apontando para o ID estável da grade;
- `aria-expanded` indicando se a coleção inteira já foi exibida;
- foco mantido no botão após cada expansão, sem salto automático para a lista.

Os checkboxes continuam com o comportamento nativo e os perfis indisponíveis continuam desabilitados.

## Ordem de implementação

1. Criar a constante de lote e o estado de quantidade visível em [`group-composer-next.tsx`](../app/postagem/group-composer-next.tsx).
2. Criar as derivações `visibleMembers`, contagem restante, IDs selecionáveis e conjunto de seleção.
3. Ajustar o `map` da caixa para renderizar somente os membros visíveis.
4. Garantir que **Selecionar todos** continue usando todos os membros selecionáveis.
5. Adicionar o rodapé com contagem e botão **Ver mais**.
6. Restaurar o limite para 20 na troca de grupo.
7. Adicionar estilos em [`publication-composer.module.css`](../app/postagem/publication-composer.module.css).
8. Validar tipos, build, comportamento manual e regressões do compositor.

## Casos de teste e critérios de aceite

### Quantidade de perfis

- [ ] Grupo com 0 perfis: nenhuma ação **Ver mais** aparece e a tela não quebra.
- [ ] Grupo com 1 a 20 perfis: todos aparecem e nenhuma ação **Ver mais** aparece.
- [ ] Grupo com 21 perfis: aparecem 20; o botão informa 1 restante; após o clique aparecem 21.
- [ ] Grupo com 40 perfis: aparecem 20; um clique mostra 40 e remove o botão.
- [ ] Grupo com 41 perfis: aparecem 20, depois 40, depois 41.
- [ ] Grupo com 300 perfis: a progressão ocorre em lotes de 20 e nunca ultrapassa o total.

### Seleção

- [ ] **Selecionar todos** com somente 20 visíveis marca todos os perfis disponíveis do grupo.
- [ ] Perfis indisponíveis não entram na seleção global.
- [ ] Ao revelar lotes seguintes, os perfis previamente selecionados aparecem marcados.
- [ ] **Limpar** remove perfis visíveis e não visíveis da seleção.
- [ ] Alternar um checkbox afeta somente aquele perfil.
- [ ] O contador do cabeçalho usa o total global selecionado e o total global de membros.

### Estado e navegação

- [ ] Expandir um grupo, trocar o destino e voltar a um grupo inicia novamente em 20 visíveis.
- [ ] Selecionar ou limpar não recolhe uma lista já expandida.
- [ ] Configurações, planos, destinos e itens de publicação continuam incluindo selecionados não visíveis.
- [ ] O modo de perfil único não é alterado.

### Layout e acessibilidade

- [ ] Desktop preserva o grid atual e posiciona o rodapé sem sobreposição.
- [ ] Mobile mantém cards e botão utilizáveis sem overflow horizontal.
- [ ] Navegação por teclado alcança checkboxes e **Ver mais**.
- [ ] Leitor de tela recebe a atualização de **Exibindo X de Y perfis**.

### Validação técnica

- [ ] Executar verificação TypeScript sem emissão.
- [ ] Executar os testes existentes do compositor e utilitários.
- [ ] Executar build de produção.
- [ ] Inspecionar no navegador que o DOM inicial contém no máximo 20 cards na caixa para um grupo grande.

## Riscos e mitigação

### Selecionar apenas os visíveis por engano

**Risco:** reutilizar `visibleMembers` no botão global.

**Mitigação:** centralizar os IDs selecionáveis derivados de `members` e testar explicitamente o caso de 300 membros com 20 visíveis.

### Perder seleção ao expandir

**Risco:** tratar cada lote como uma página independente.

**Mitigação:** o lote controla somente renderização; `profileIds` permanece global e não é alterado por **Ver mais**.

### Custo após selecionar todos

**Risco:** embora a caixa renderize somente 20 cards, selecionar 300 perfis continuará criando os cards completos de configuração abaixo, conforme o comportamento atual.

**Mitigação nesta etapa:** manter o escopo aprovado e registrar esse comportamento. Se o uso real mostrar lentidão, uma segunda fase deverá virtualizar ou recolher os cards de configuração, sem mudar a seleção global.

### Dados continuam vindo completos do servidor

**Risco:** a melhoria reduz DOM e altura, mas não o volume da consulta inicial de perfis e métricas.

**Mitigação nesta etapa:** não introduzir API paginada sem necessidade, pois os IDs completos são necessários para seleção global e o compositor já depende dos dados completos. Uma otimização de rede futura exigirá separar resumo/IDs selecionáveis dos detalhes carregados sob demanda.

## Fora do escopo

- paginação no banco ou nova rota de API;
- busca por nome ou usuário;
- filtros por status;
- botão **Ver menos**;
- rolagem infinita;
- virtualização dos cards de configuração dos perfis selecionados;
- mudança no payload de criação das publicações;
- alteração de schema ou migration do Supabase.

## Resultado esperado

Para um grupo com 300 Instagrams, a caixa abre compacta com apenas 20 cards. O usuário pode expandi-la de 20 em 20, enquanto seleção, contadores e configuração continuam globais. A implementação fica isolada no componente e no CSS local, sem mudança de banco, API ou regra de publicação.
