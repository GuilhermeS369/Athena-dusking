'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function ClearZernioSyncConflictsButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function clearLogs() {
    if (!window.confirm(`Limpar ${count} conflito(s) histórico(s) de sincronização? Esta ação não pode ser desfeita.`)) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/operation/zernio-sync-conflicts', { method: 'DELETE' });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível limpar os logs.');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Falha inesperada ao limpar os logs.');
    } finally {
      setPending(false);
    }
  }

  return <div className="operation-header-actions">
    <button className="button button-secondary" type="button" onClick={clearLogs} disabled={pending || count === 0}>
      {pending ? 'Limpando…' : 'Limpar logs'}
    </button>
    {error && <small className="inline-message inline-message-error" role="alert">{error}</small>}
  </div>;
}
