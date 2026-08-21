'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Props = {
  incidentId: string;
  username: string;
  accountId: string;
  retainedConnectionLabel: string;
  removedConnectionLabel: string;
};

export default function ZernioGlobalRemovalButton(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const expected = `REMOVER @${props.username}`;

  async function removeGlobally() {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/operation/zernio-disconnections/${props.incidentId}/global-remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível remover o perfil das contas Zernio.');
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Falha inesperada na remoção.');
    } finally {
      setPending(false);
    }
  }

  return <>
    <button className="danger-action" type="button" onClick={() => setOpen(true)}>Excluir das duas Zernio</button>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={() => !pending && setOpen(false)}>
      <section className="panel bulk-modal zernio-confirm-modal zernio-global-removal-modal" role="dialog" aria-modal="true" aria-labelledby={`global-remove-${props.incidentId}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="zernio-global-removal-header">
          <span className="section-kicker">Remoção global destrutiva</span>
          <h2 id={`global-remove-${props.incidentId}`}>Remover <span>@{props.username}</span>?</h2>
          <p>Confira o perfil e as duas chaves antes de confirmar.</p>
        </header>
        <section className="zernio-global-removal-summary" aria-label="Perfil afetado">
          <div className="zernio-global-removal-profile"><span>Perfil que será removido</span><strong>@{props.username}</strong></div>
          <div className="zernio-global-removal-account"><span>Account ID compartilhado</span><code>{props.accountId}</code></div>
          <div className="zernio-global-removal-connections">
            <div><span>Chave preservada</span><strong>{props.retainedConnectionLabel}</strong></div>
            <div><span>Chave excedente</span><strong>{props.removedConnectionLabel}</strong></div>
          </div>
        </section>
        <section className="zernio-global-removal-warning" aria-label="Consequências da remoção">
          <strong>Atenção: o DELETE deste account ID é global.</strong>
          <p>A Zernio removerá o Instagram das duas chaves. Depois da confirmação remota, o perfil local receberá soft delete e sairá das telas operacionais.</p>
          <p>Histórico e auditoria serão preservados, mas será necessário reconectar <strong>@{props.username}</strong>.</p>
        </section>
        <label className="zernio-global-removal-confirmation" htmlFor={`global-remove-confirmation-${props.incidentId}`}>
          <span>Confirmação obrigatória</span>
          <small>Digite exatamente <strong>{expected}</strong></small>
          <input id={`global-remove-confirmation-${props.incidentId}`} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={pending} autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="inline-message inline-message-error" role="alert">{error}</p>}
        <div className="modal-actions zernio-global-removal-actions"><button className="button button-secondary" type="button" onClick={() => setOpen(false)} disabled={pending}>Cancelar</button><button className="button button-danger" type="button" onClick={removeGlobally} disabled={pending || confirmation !== expected}>{pending ? 'Removendo…' : 'Remover das duas chaves'}</button></div>
      </section>
    </div>}
  </>;
}
