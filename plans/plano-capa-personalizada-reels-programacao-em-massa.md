# Plano técnico — capa personalizada de Reels na programação em massa

## 1. Objetivo

Adicionar à tela **Programar em massa** uma configuração opcional de capa personalizada, exibida **somente quando o formato escolhido for Reel**.

O operador poderá:

1. ativar o uso de capa personalizada;
2. escolher um grupo/pasta de mídia da galeria como origem das capas;
3. navegar pelas imagens desse grupo;
4. selecionar exatamente **uma imagem**;
5. revisar a capa escolhida antes da confirmação;
6. aplicar essa mesma imagem a todas as publicações geradas pelo plano compacto, independentemente da quantidade de perfis ou postagens.

A capa será enviada à Zernio no campo oficial `platformSpecificData.instagramThumbnail`. A primeira versão ficará restrita a perfis com provedor Zernio; o publicador Meta oficial continuará sem capa personalizada para não introduzir um comportamento não solicitado nem misturar contratos de provedores.

---

## 2. Requisitos funcionais consolidados

### 2.1 Escopo da interface

- Disponível somente no modo **Programar em massa**.
- Disponível somente quando `format === "reel"`.
- A nova área ficará imediatamente abaixo do cartão **Mídias da origem** e antes da barra fixa **Revisar plano compacto**.
- Ao trocar o formato de Reel para Imagem ou Story:
  - a área desaparece;
  - a configuração deixa de integrar a requisição;
  - a seleção local é limpa para impedir capa residual em um formato incompatível.
- Ao voltar para Reel, o recurso retorna desligado por padrão. Isso evita configuração invisível e comportamento implícito.

### 2.2 Ativação

- O cartão começa em estado compacto, com título, descrição e um controle explícito **Usar capa personalizada**.
- Desligado:
  - não exige grupo nem imagem;
  - não altera nenhum payload de publicação;
  - mantém o comportamento atual dos Reels.
- Ligado:
  - abre o conteúdo configurável com uma transição discreta;
  - exige selecionar uma origem e uma imagem antes da revisão.

### 2.3 Origem e seleção

- O seletor de origem usará os mesmos grupos/pastas de mídia já existentes na galeria.
- Também poderá oferecer **Sem grupo**, mantendo consistência com a origem de mídia atual.
- A origem de capas é independente da origem dos vídeos.
- A listagem retornará somente imagens que estejam:
  - na organização ativa;
  - prontas;
  - não apagadas;
  - sem exclusão pendente;
  - com arquivo físico existente no Storage.
- Vídeos nunca serão apresentados como opção de capa.
- A grade será paginada; selecionar uma imagem não depende de carregar todas as imagens do grupo.
- A seleção será exclusiva: escolher uma imagem substitui a anterior.
- O cartão mostrará nome e miniatura da imagem selecionada, além de uma ação para remover/trocar.

### 2.4 Aplicação em escala

- Uma única referência de capa será persistida no plano compacto.
- Não haverá cópia do arquivo por perfil ou por postagem.
- Todos os itens materializados pelo plano receberão a referência à mesma capa.
- No momento da publicação, cada chamada à Zernio receberá uma URL assinada válida da imagem.
- O desenho deve funcionar da mesma forma para dezenas ou milhares de publicações, sem expandir dados no navegador e sem multiplicar blobs no banco.

---

## 3. Decisões de arquitetura

### 3.1 A capa é uma configuração do plano e um snapshot do item

A capa será armazenada em dois níveis:

1. **Plano compacto**: preserva a intenção original e permite que o gerador incremental materialize os itens.
2. **Item de publicação**: snapshot durável usado pelo dispatcher no momento da execução.

Isso evita depender de consulta a evento JSON, nome de lote ou grupo depois da materialização. Também garante que itens já gerados continuem publicáveis após o plano concluir.

Campos propostos:

- `bulk_publication_plans.reel_cover_media_asset_id uuid null`;
- `publication_items.reel_cover_media_asset_id uuid null`.

Ambos referenciam `media_assets(id)` com política de exclusão restritiva, e ambos terão invariantes:

- somente planos/itens no formato Reel podem possuir capa;
- a capa precisa pertencer à mesma organização;
- a capa precisa ser do tipo imagem;
- itens antigos permanecem com `null` e mantêm o comportamento atual.

O plano também deverá guardar no `request_hash` o identificador da capa. Assim, uma chave de idempotência não pode ser reutilizada silenciosamente com outra imagem.

### 3.2 Não reutilizar `thumbnail_storage_path`

`thumbnail_storage_path` é uma miniatura técnica associada a um vídeo. A nova capa é uma imagem editorial independente, escolhida na galeria e potencialmente reutilizada por muitos vídeos.

Portanto:

- a imagem escolhida continuará sendo um `media_asset` normal do tipo imagem;
- o caminho usado será `media_assets.storage_path`;
- nenhuma cópia será criada em `thumbnails/`;
- nenhuma transformação da prévia será usada como URL final da Zernio.

### 3.3 URL privada e assinada, não bucket público

O bucket atual pode continuar privado. O Supabase já disponibiliza URLs assinadas e o publicador atual usa validade de 24 horas para mídia entregue a provedores.

No envio à Zernio:

- gerar URL assinada da capa no momento da criação remota;
- usar validade de 24 horas, alinhada à mídia principal;
- enviar a URL original assinada, sem transformação de preview;
- nunca persistir a URL assinada, pois ela expira;
- persistir somente o ID/caminho estável da mídia.

Uma mesma capa usada em 10.000 postagens não cria 10.000 arquivos. Inicialmente poderá gerar uma assinatura por execução. Como otimização segura, poderá haver cache em memória por `storage_path` com margem de expiração, sem transformar esse cache em requisito de consistência.

### 3.4 Restrição ao provedor Zernio

Como a necessidade e o contrato investigado são da Zernio, a revisão deve rejeitar capa personalizada quando qualquer perfil selecionado não usar o provedor Zernio.

Comportamento de UX:

- a área continua visível para Reel;
- ao ativá-la com perfis Meta oficial selecionados, mostrar uma mensagem clara de incompatibilidade;
- bloquear a revisão enquanto houver perfis incompatíveis;
- não retirar perfis silenciosamente da programação.

Essa regra deve existir tanto no cliente quanto no servidor.

---

## 4. Experiência visual e CSS

### 4.1 Posicionamento

O layout atual possui:

- painel de perfis sticky à esquerda;
- coluna de configuração à direita;
- cartões empilhados na coluna direita;
- ação de revisão sticky no rodapé da coluna.

A nova área será outro cartão dentro de `.configuration`, logo abaixo de **Mídias da origem**. Isso preserva o comportamento solicitado: ao descer a configuração, o painel de perfis continua acompanhando pelo `position: sticky` existente.

Não será criada uma terceira coluna nem alterada a largura do workspace.

### 4.2 Composição do cartão

Estado desligado:

- mesmo fundo, borda, raio e espaçamento dos cartões atuais;
- cabeçalho com ícone/miniatura decorativa discreta, título **Capa personalizada do Reel** e texto curto;
- switch visual à direita, com rótulo textual para acessibilidade.

Estado ligado:

- borda roxa levemente destacada;
- bloco de orientação explicando que a mesma imagem será aplicada a todas as postagens;
- seletor de grupo em largura total;
- grade de capas com proporção vertical para comunicar o resultado de Reel;
- seleção marcada por borda de destaque, glow suave, check e estado `aria-pressed`;
- painel compacto da capa selecionada com miniatura vertical, nome e ação **Remover**;
- carregamento, vazio, erro e paginação no mesmo vocabulário visual de **Mídias da origem**.

### 4.3 Novas classes previstas

Adicionar ao CSS module, sem estilos globais:

- `.coverCard`;
- `.coverHeader`;
- `.coverToggle` e estados ligados/desligados;
- `.coverBody`;
- `.coverNotice`;
- `.coverOriginField`;
- `.coverGrid`;
- `.coverOption` e `.coverOptionSelected`;
- `.coverPreview`;
- `.coverPreviewImage`;
- `.coverMeta`;
- `.coverEmpty`, `.coverLoading` e `.coverError`;
- `.coverLoadMore`.

### 4.4 Responsividade

- Desktop: grade com miniaturas verticais usando `auto-fill` e largura mínima coerente com a grade atual.
- Até 820 px: o painel esquerdo deixa de ser sticky conforme regra existente; o cartão ocupa a largura total.
- Até 620 px: cabeçalho e preview empilham, ações ocupam largura total.
- Até 400 px: três miniaturas compactas por linha quando houver espaço; caso contrário, `auto-fill` evita overflow.
- Respeitar `prefers-reduced-motion` para a expansão e estados de seleção.

### 4.5 Acessibilidade

- Switch como botão com `role="switch"` e `aria-checked`, ou checkbox nativo visualmente estilizado.
- Grade navegável por teclado.
- Cada imagem será um botão com `aria-pressed`.
- Nome do arquivo será texto acessível e também `title` para nomes longos.
- Mensagens de carregamento/erro usarão `role="status"` quando apropriado.
- Foco visível seguirá a cor `--bulk-accent-bright` já usada na página.

---

## 5. API para procurar capas

### 5.1 Endpoint dedicado

Criar um endpoint de leitura dedicado, por exemplo:

`GET /api/bulk-publications/covers`

Parâmetros:

- `originType=group|ungrouped`;
- `groupId` quando aplicável;
- `cursor` opcional;
- `limit`, limitado no servidor.

Resposta:

```json
{
  "assets": [
    {
      "id": "uuid",
      "originalName": "capa-01.jpg",
      "kind": "image",
      "thumbnailUrl": "url-assinada-curta"
    }
  ],
  "hasMore": true,
  "nextCursor": "..."
}
```

### 5.2 Consulta e validação

Reutilizar o padrão de cursor já existente, mas forçar `kind = image` no servidor.

A consulta deve validar:

- associação ao grupo selecionado ou ausência de grupos;
- organização ativa;
- status pronto;
- arquivo no Storage;
- ausência de exclusão e exclusão pendente.

As URLs de `thumbnailUrl` serão assinadas por poucos minutos e usadas apenas na interface. Elas não serão enviadas na confirmação do plano.

---

## 6. Contrato do plano compacto

### 6.1 Modelo TypeScript

Adicionar ao pedido compacto:

```ts
type BulkReelCover = {
  enabled: true;
  origin: BulkMediaOrigin;
  mediaAssetId: string;
} | {
  enabled: false;
};
```

E incluir `reelCover` em `BulkRotationRequest`.

Regras no parser:

- formatos diferentes de Reel só aceitam `enabled: false` ou ausência;
- quando ligado, origem e UUID são obrigatórios;
- o ID é normalizado e entra no fingerprint da revisão;
- campos desconhecidos ou combinações inconsistentes geram erro 400.

### 6.2 Revisão

O endpoint de revisão deve, além das verificações existentes:

1. garantir que o formato é Reel;
2. garantir que todos os perfis selecionados são Zernio;
3. carregar a imagem por ID na organização ativa;
4. verificar tipo, status, exclusão e Storage;
5. confirmar que a imagem ainda pertence à origem de capas informada;
6. devolver um resumo sanitizado da capa na revisão:
   - ID;
   - nome;
   - origem/grupo;
   - miniatura assinada para exibição no modal.

O token de revisão assina a requisição completa. Trocar capa, grupo ou estado de ativação invalida a revisão anterior.

### 6.3 Modal de revisão

Quando a capa estiver habilitada, exibir:

- linha **Capa do Reel: personalizada**;
- nome do grupo de capas;
- nome do arquivo escolhido;
- miniatura vertical.

Quando desligada, exibir **Capa do Reel: automática** ou omitir a linha. A primeira opção é preferível por deixar a decisão explícita.

---

## 7. Persistência e funções SQL

### 7.1 Migration nova

Criar uma migration posterior à atual, contendo:

1. coluna de capa em `bulk_publication_plans`;
2. coluna de capa em `publication_items`;
3. índices apenas se necessários para proteção/diagnóstico;
4. constraints de formato;
5. trigger de mesma organização e tipo imagem;
6. atualização da função que protege mídias usadas por jobs/planos ativos;
7. atualização das funções de criação de plano intervalo e horário diário;
8. atualização dos wrappers v2;
9. atualização da materialização incremental;
10. grants/revokes e reload do schema.

### 7.2 Funções de criação de plano

As funções de confirmação receberão `p_reel_cover_media_asset_id uuid default null`.

Antes de criar o plano:

- rejeitar capa se `p_format <> 'reel'`;
- validar a mídia com lock/leitura consistente;
- validar organização, tipo imagem, status e objeto físico;
- validar pertencimento à origem informada na requisição;
- incluir o ID no hash idempotente;
- persistir o ID no plano.

A função diária e a função por intervalo devem compartilhar exatamente as mesmas regras.

### 7.3 Materialização incremental

Ao inserir cada linha em `publication_items`, copiar `plan_row.reel_cover_media_asset_id`.

A verificação de idempotência do chunk também deve comparar a capa. Isso impede considerar materializado um item com a mídia principal correta, mas capa divergente.

Os eventos de fila poderão incluir `reel_cover_media_asset_id` no metadata apenas para auditoria; a fonte operacional continuará sendo a coluna do item.

### 7.4 Proteção contra exclusão

Atualizar `media_asset_is_in_active_generation_job` para considerar também:

- capa referenciada por plano compacto em estado ativo;
- capa referenciada por item ainda publicável/agendado.

O fluxo de exclusão não deve deixar uma capa selecionada sem arquivo físico. Para planos concluídos cuja fila ainda possua itens futuros, a referência no item continua protegendo a mídia.

Como melhoria de mensagem, a galeria poderá informar que a imagem está sendo usada como capa de publicações programadas.

---

## 8. Dispatcher e integração Zernio

### 8.1 Carregamento do item

O dispatcher deverá:

- receber `reel_cover_media_asset_id` no item reclamado, ou carregá-lo junto da consulta do item;
- buscar a mídia de capa separadamente da lista `publication_item_media`;
- validar que é imagem, pertence à organização, está pronta e não foi apagada;
- acrescentar ao `PublicationWorkItem` um campo opcional de capa, sem misturá-la à mídia principal do post.

Modelo sugerido:

```ts
type PublicationCover = {
  id: string;
  storage_path: string;
  kind: "image";
};
```

### 8.2 Payload da Zernio

Para Reel com capa:

```json
{
  "platformSpecificData": {
    "shareToFeed": true,
    "instagramThumbnail": "URL_ASSINADA_DA_CAPA"
  }
}
```

Regras:

- nunca enviar `instagramThumbnail` em imagem, Story ou carrossel;
- manter `shareToFeed: true`;
- gerar URL no momento da primeira criação na Zernio;
- em polling de um `creation_id` existente, não gerar nem reenviar a capa;
- erros por capa ausente/inválida devem ter códigos específicos e não retryable quando o arquivo realmente não existe;
- falhas transitórias de assinatura/Storage permanecem retryable.

### 8.3 Meta oficial

O servidor impede a criação do plano com capa quando houver perfil Meta oficial. Mesmo assim, o dispatcher deve ser defensivo:

- se um item Meta oficial legado/anômalo chegar com capa, falhar com erro de configuração explícito;
- não ignorar silenciosamente a capa, pois isso publicaria conteúdo diferente do revisado.

---

## 9. Estado do cliente

Adicionar estados independentes da mídia principal:

- `coverEnabled`;
- `coverOriginKey`;
- `coverSelectedAsset`;
- `coverAssets`;
- `coverCursor`;
- `coverHasMore`;
- `loadingCovers`;
- `loadingMoreCovers`;
- controlador/sequence para abortar respostas obsoletas.

Regras de invalidação:

- toda alteração invalida `review` e limpa mensagens antigas relacionadas;
- trocar origem limpa a imagem selecionada e recarrega a primeira página;
- desligar limpa origem, seleção e listagem;
- trocar formato para não Reel executa a mesma limpeza;
- `dirty` passa a considerar a configuração de capa;
- `resetDraft` restaura o recurso desligado;
- confirmar o plano limpa a configuração junto do restante do rascunho.

---

## 10. Validações e mensagens

### Cliente

Bloquear **Revisar plano compacto** quando:

- capa está ligada sem origem;
- capa está ligada sem imagem;
- imagem selecionada sumiu da listagem após troca de origem;
- existe perfil selecionado fora da Zernio;
- carregamento/erro impede confirmar a validade da seleção.

Mensagens sugeridas:

- `Selecione a pasta/grupo das capas.`
- `Selecione uma imagem para usar como capa.`
- `A capa personalizada está disponível apenas para perfis Zernio.`
- `A imagem escolhida não está mais disponível. Escolha outra capa.`

### Servidor

Nunca confiar no estado visual. Repetir todas as validações em review e confirm. Na confirmação, validar novamente porque o token pode ter até dez minutos e a mídia pode mudar nesse intervalo.

---

## 11. Testes

### 11.1 Testes TypeScript

Ampliar os testes do parser/fingerprint para cobrir:

- capa desligada;
- capa válida em Reel;
- capa em formato incompatível;
- origem/UUID inválidos;
- fingerprint diferente ao trocar a capa;
- token de revisão incompatível após alteração da capa.

Adicionar testes do cliente/utilitários para:

- limpeza ao trocar formato;
- seleção exclusiva;
- troca de origem removendo seleção;
- detecção de perfil não Zernio;
- inclusão no estado `dirty`.

Adicionar testes do payload da Zernio, idealmente extraindo a montagem para função pura:

- Reel sem capa mantém payload atual;
- Reel com capa inclui `instagramThumbnail`;
- Story/imagem nunca recebem o campo;
- URL da capa não aparece como `mediaItems`.

### 11.2 Testes SQL

Criar teste de migration cobrindo:

- plano Reel com uma imagem de capa válida;
- rejeição de vídeo como capa;
- rejeição de mídia de outra organização;
- rejeição de capa para Story/Imagem;
- hash/idempotência distingue capas;
- snapshot da capa no plano;
- cópia para todos os itens materializados em múltiplos chunks/perfis;
- verificação idempotente do chunk inclui capa;
- proteção contra exclusão enquanto plano ou itens estiverem ativos;
- plano sem capa continua retrocompatível;
- caminhos intervalo e horário diário têm o mesmo resultado.

### 11.3 Testes de rota

- endpoint de capas retorna somente imagens elegíveis da origem;
- paginação estável e sem duplicação;
- organização isolada por RLS/consulta;
- review rejeita perfis Meta oficial;
- confirm rejeita capa removida após review;
- resposta de review retorna apenas dados sanitizados e URL curta de preview.

### 11.4 Testes manuais de interface

- painel esquerdo permanece sticky durante todo o novo cartão;
- barra de revisão não cobre controles do cartão;
- desktop, tablet e celular;
- teclado, foco e leitor de tela;
- loading, grupo vazio, muitas capas e erro de rede;
- troca rápida de grupos não mostra resposta atrasada;
- seleção de uma capa entre mais de uma página;
- revisão e confirmação com grande projeção, sem expansão no navegador.

---

## 12. Sequência de implementação

1. Criar migration com modelo, constraints e proteção de exclusão.
2. Atualizar criação de planos e materialização incremental, preservando wrappers v2 e agenda diária.
3. Atualizar parser, fingerprint e contrato de review/confirm.
4. Criar endpoint paginado de capas.
5. Atualizar dispatcher e modelo `PublicationWorkItem`.
6. Atualizar montagem do payload da Zernio.
7. Implementar estado e regras da interface.
8. Inserir o cartão abaixo de **Mídias da origem**.
9. Adicionar CSS responsivo e acessível seguindo o module atual.
10. Atualizar modal de revisão e reset do rascunho.
11. Implementar testes SQL, TypeScript e rotas.
12. Rodar typecheck, testes e build.
13. Fazer validação manual com um Reel de teste em conta Zernio antes de liberar em escala.

---

## 13. Critérios de aceite

- A seção só aparece em Programar em massa + Reel.
- O operador ativa, escolhe um grupo e seleciona exatamente uma imagem.
- A mesma capa é aplicada a todas as postagens do plano.
- O navegador continua enviando um plano compacto, não milhares de itens.
- A imagem não é duplicada no Storage.
- A Zernio recebe `platformSpecificData.instagramThumbnail` com URL válida.
- Planos sem capa mantêm exatamente o comportamento atual.
- Perfis Meta oficial não podem ser confirmados com capa Zernio.
- A capa não pode ser apagada enquanto houver plano/itens ativos que dependam dela.
- A revisão mostra claramente qual capa será aplicada.
- O layout mantém o painel esquerdo acompanhando a rolagem e permanece responsivo.
- Testes cobrem consistência, escala, idempotência e isolamento por organização.

---

## 14. Fora do escopo desta entrega

- capa personalizada no compositor tradicional;
- capa diferente por perfil ou por vídeo;
- rotação aleatória de várias capas;
- editor/crop de imagem dentro do Athena;
- escolha de frame do vídeo por offset;
- suporte de capa para Story, imagem ou carrossel;
- tentativa de adaptar automaticamente o recurso ao Meta oficial.

Essas extensões podem ser adicionadas depois sem quebrar o modelo proposto, mas não fazem parte desta implementação.
