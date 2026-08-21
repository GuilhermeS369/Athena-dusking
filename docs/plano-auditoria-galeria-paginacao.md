# Plano de correção e auditoria da galeria

## Decisões funcionais confirmadas

- A guia **Postados na galeria** contém exclusivamente mídias cujo primeiro envio foi concluído com sucesso (`first_published_at IS NOT NULL`).
- Uma mídia apenas agendada não pode entrar nessa guia.
- Uma mídia já publicada e agendada novamente deve permanecer em **Postados**, exibindo simultaneamente os estados **Publicada** e **Agendada novamente**.
- A paginação é de 30 mídias por página.

## Problemas encontrados

### 1. Total global apresentado durante um filtro de grupo

O contador das guias é obtido na carga inicial sem filtro de grupo. Por isso, **Postados na galeria (78)** representa a organização inteira, não o grupo selecionado. A listagem posterior é filtrada corretamente, mas o contador permanece global e induz ao erro.

### 2. Contrato da API não retorna o total filtrado

`GET /api/media` retorna a página e o cursor, porém não a quantidade total para a mesma combinação de escopo, grupo, tipo, status e busca. O cliente só consegue informar itens já carregados.

### 3. Estado de fim é incompleto

A mensagem “Não há mais mídias para exibir” só é ativada após clicar em “Ver mais” e receber uma última página sem continuidade. Para resultados iniciais de até 30 itens, a interface não comunica explicitamente que a lista acabou.

### 4. Diagnóstico incorreto de página repetida

O carregamento incremental calcula a quantidade adicionada dentro de um atualizador de estado. A checagem seguinte pode ocorrer antes da atualização e acusar, indevidamente, que não vieram itens novos.

### 5. Ações de cards e estado local podem ficar inconsistentes

- A exclusão individual remove o card, mas não atualiza contadores, cache de páginas e seleção global de forma completa.
- Após uma alteração de grupos, a lista visível pode precisar ser reconciliada com o filtro ativo, sobretudo em **Naty**, **Sem grupo** e visualização por grupos.
- O botão “Gerar miniatura” é apenas uma mensagem informativa; não gera nem recupera uma miniatura. O rótulo induz a uma ação inexistente.

### 6. Organização de mídia ainda não é atômica

Nas operações em massa, **replace** primeiro apaga associações e depois cria as novas. Se a inserção falhar, a mídia pode ficar sem grupo. A operação deve ser transacional por RPC no banco.

### 7. Não há cobertura automatizada da galeria

O projeto possui teste apenas para o compositor. Não há teste de API, paginação, ações ou combinação de filtros da galeria.

## Implementação proposta

### Etapa A — Contrato único de consulta

1. Centralizar os filtros de `GET /api/media` em uma função reutilizável.
2. Executar a consulta de página e a contagem exata em paralelo, com os mesmos filtros.
3. Retornar `total` além de `assets`, `hasMore` e `nextCursor`.
4. Retornar `total: 0` também no atalho de grupo inexistente/vazio.
5. Manter cursores ordenados por `created_at DESC, id DESC` e validar que `hasMore` implica cursor não nulo.

### Etapa B — Estado do cliente e paginação

1. Trocar o estado ocioso `totalAssets` por total da consulta ativa.
2. Reinicializar total, cursor, seleção, cache e mensagem de fim em cada troca de escopo, grupo, tipo, status ou busca.
3. Mostrar “Exibindo X de Y mídia(s)” para qualquer combinação de filtro.
4. Mostrar “Não há mais mídias para exibir” quando `X === Y` e houver ao menos uma mídia — inclusive na primeira página.
5. Só renderizar “Ver mais mídias” se houver cursor válido e `X < Y`.
6. Calcular itens inéditos fora do atualizador de estado e tratar cursor repetido como erro recuperável, sem reportar falso positivo.
7. Invalidar cache e reconciliar lista, seleção, total e contador de escopo após upload, exclusão e atualização de grupos.

### Etapa C — Semântica e interface

1. Manter os totais das guias como totais globais explicitamente identificados, ou substituir pelo total do filtro atual; a recomendação é exibir **Postados (78 no total)** e detalhar o total filtrado no resultado.
2. Quando houver `first_published_at` e agendamento pendente, exibir os selos **Publicada** e **Agendada novamente**.
3. Renomear/remover o botão “Gerar miniatura” até existir uma operação real. Se for implementada, criar rota e processamento efetivos, com estados de carregamento e erro.
4. Revisar os estados vazios para distinguirem: galeria vazia, filtro sem resultados e carregamento.

### Etapa D — Integridade das ações

1. Criar uma RPC transacional para adicionar, remover e substituir grupos em lote; validar organização, mídias e grupos no banco.
2. Definir comportamento explícito para `replace` com uma ou várias associações de destino.
3. Recarregar ou reconciliar cards depois de organizar mídias para que filtros **Naty**, **Sem grupo** e visualização por grupos permaneçam fiéis.
4. Fazer exclusão individual seguir o mesmo caminho de invalidação, atualização de contador e feedback da exclusão em lote.
5. Preservar a mensagem de remoção parcial de Storage, registrando-a como alerta sem repor card já removido do catálogo.

### Etapa E — Validação automatizada e manual

Adicionar testes de unidade para serialização de filtro/cursores e testes de integração do endpoint com banco de teste ou mocks do Supabase. Validar obrigatoriamente:

| Escopo | Grupo | Filtros adicionais | Volumes |
| --- | --- | --- | --- |
| Disponíveis | Todos, Naty, Sem grupo | nenhum | 0, 1–29, 30, 31, 61+ |
| Postados | Todos, Naty, Sem grupo | nenhum | 0, 1–29, 30, 31, 61+ |
| Ambos | Todos, Naty, Sem grupo | imagem, vídeo, status, busca | 0, uma página e múltiplas páginas |
| Postados | Naty | publicada + reagendada | deve mostrar ambos os selos |
| Ambos | Todos, Naty, Sem grupo | organizar, remover e excluir | cards, contadores e cache coerentes |

## Critérios de aceite

- Ao filtrar Naty, o usuário vê o total de Naty para aquela combinação de filtros e não confunde o total global com o filtrado.
- Para 78 itens, são carregados 30 inicialmente e todas as páginas seguintes até 78, sem duplicação ou mensagem espúria.
- Para 30 ou menos itens, não há botão enganoso e o fim é comunicado.
- Itens somente agendados nunca entram na guia de postados.
- Itens publicados e reagendados mostram ambos os estados.
- Alterações de grupo, upload e exclusão não deixam cards, seleção, contadores ou cache desatualizados.
- Operações de grupos não deixam mídia sem associação devido a falha intermediária.
- A matriz de filtros e volumes acima passa antes da entrega.
