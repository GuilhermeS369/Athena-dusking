# Rollout da FIFO OAuth e reassociação Zernio

## Escopo

A correção serializa o OAuth antes do redirect por conexão Zernio, mantém o
baseline remoto completo e transfere a decisão sobre `accountId` reciclado para
o worker. Nenhuma etapa descrita aqui altera inventário remoto diretamente.

## Ordem de publicação

1. Pausar temporariamente novas adições e o worker de adições Zernio.
2. Aplicar a migration 161.
3. Publicar a aplicação web com as rotas `start`, `continue` e `callback`.
4. Publicar o worker Zernio atualizado.
5. Reiniciar o worker e reabrir novas adições.
6. Executar um smoke test com dois celulares na mesma conexão:
   - o primeiro deve abrir o Instagram;
   - o segundo deve permanecer na espera;
   - o segundo só pode ser promovido após o primeiro ficar terminal;
   - conta já existente deve falhar sem criar perfil;
   - reassociação comprovada deve atualizar o vínculo sem duplicá-lo.

## Validações pós-deploy

- No máximo um turno `active` por `(organization_id, zernio_connection_id)`.
- Nenhum turno ativo terminal sem `finished_at`.
- No máximo um claim com `superseded_at is null` para cada `zernio_account_id`.
- Claims substituídos devem registrar `superseded_by_attempt_id`.
- Attempts em `callback_received` devem chegar a estado terminal pelo worker.
- `remote_authorization_superseded` não pode criar perfil nem reserva órfã.
- Nenhuma RPC legada de claim com quatro argumentos ou reserva com três
  argumentos deve existir.

## Rollback

O rollback do código deve ser coordenado; não reaplique a migration 160 e não
remova as colunas de auditoria. Se for necessário interromper o rollout:

1. Pausar novas adições e o worker.
2. Reverter aplicação e worker para uma versão que não inicie novos OAuths.
3. Preservar turnos, claims e colunas `superseded_*` para auditoria.
4. Encerrar manualmente apenas turnos confirmadamente órfãos por uma migration
   revisada; nunca editar produção por comandos ad hoc.
5. Reabrir o fluxo somente após validar as assinaturas RPC esperadas.

Como a migration remove assinaturas legadas e introduz invariantes mais fortes,
o rollback seguro é roll-forward: uma migration posterior compatível, e não a
remoção dos controles de exclusividade.
