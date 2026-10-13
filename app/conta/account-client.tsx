'use client';

import { FormEvent, useState } from 'react';

import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { signOutAndLeave, type SignOutScope } from '@/lib/auth/sign-out-client';

import styles from './account.module.css';

type AccountOrganization = { id: string; name: string; role: 'admin' | 'operator' | 'viewer' };

const roleLabels: Record<AccountOrganization['role'], string> = {
  admin: 'Administrador',
  operator: 'Operador',
  viewer: 'Somente leitura',
};

export default function AccountClient({
  email,
  organizations,
  activeOrganizationId,
}: {
  email: string;
  organizations: AccountOrganization[];
  activeOrganizationId: string;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [signingOut, setSigningOut] = useState<SignOutScope | null>(null);
  const [sessionMessage, setSessionMessage] = useState('');

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage(null);

    if (newPassword !== confirmPassword) {
      setPasswordMessage({ tone: 'error', text: 'A confirmação não é igual à nova senha.' });
      return;
    }

    setIsSavingPassword(true);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;

      if (!response.ok) {
        setPasswordMessage({ tone: 'error', text: payload?.error ?? 'Não foi possível trocar a senha.' });
        return;
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({ tone: 'success', text: 'Senha alterada. Use a nova senha no próximo login.' });
    } catch {
      setPasswordMessage({ tone: 'error', text: 'Não foi possível conectar ao servidor.' });
    } finally {
      setIsSavingPassword(false);
    }
  }

  async function signOut(scope: SignOutScope) {
    if (scope === 'global' && !window.confirm('Sair de todos os aparelhos? Isso encerra também as sessões abertas pelo link espelho.')) return;

    setSigningOut(scope);
    setSessionMessage('');
    try {
      await signOutAndLeave(scope);
    } catch {
      setSessionMessage('Não foi possível encerrar a sessão. Tente novamente.');
      setSigningOut(null);
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className="eyebrow">Conta</span>
        <h1>Minha conta</h1>
        <p>Seus dados de acesso ao painel. Vale para o seu usuário, em qualquer organização.</p>
      </header>

      <section className={`panel ${styles.card}`} aria-labelledby="account-identity">
        <h2 id="account-identity">Acesso</h2>
        <dl className={styles.facts}>
          <div><dt>E-mail</dt><dd>{email || '—'}</dd></div>
        </dl>
        <ul className={styles.organizations} aria-label="Organizações">
          {organizations.map((organization) => (
            <li key={organization.id}>
              <strong>{organization.name}</strong>
              <span>{roleLabels[organization.role]}{organization.id === activeOrganizationId ? ' · ativa agora' : ''}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={`panel ${styles.card}`} aria-labelledby="account-password">
        <h2 id="account-password">Alterar senha</h2>
        <form className={`auth-form ${styles.form}`} onSubmit={changePassword}>
          <label htmlFor="account-current-password">Senha atual</label>
          <input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />

          <label htmlFor="account-new-password">Nova senha</label>
          <input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            aria-describedby="account-new-password-help"
            required
          />
          <small id="account-new-password-help" className="field-help">Pelo menos {MIN_PASSWORD_LENGTH} caracteres.</small>

          <label htmlFor="account-confirm-password">Confirmar nova senha</label>
          <input
            id="account-confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />

          <button className="button button-secondary" disabled={isSavingPassword} type="submit">
            {isSavingPassword ? 'Salvando…' : 'Alterar senha'}
          </button>
        </form>
        {passwordMessage && (
          <p className={passwordMessage.tone === 'success' ? styles.success : styles.error} role={passwordMessage.tone === 'success' ? 'status' : 'alert'}>
            {passwordMessage.text}
          </p>
        )}
      </section>

      <section className={`panel ${styles.card}`} aria-labelledby="account-session">
        <h2 id="account-session">Sessão</h2>
        <p className={styles.hint}>Sair encerra o acesso só neste aparelho. Os outros aparelhos continuam logados.</p>
        <div className={styles.actions}>
          <button className="button button-ghost" disabled={signingOut !== null} type="button" onClick={() => void signOut('local')}>
            {signingOut === 'local' ? 'Saindo…' : 'Sair deste aparelho'}
          </button>
          <button className="button button-danger" disabled={signingOut !== null} type="button" onClick={() => void signOut('global')}>
            {signingOut === 'global' ? 'Saindo…' : 'Sair de todos os aparelhos'}
          </button>
        </div>
        {sessionMessage && <p className={styles.error} role="alert">{sessionMessage}</p>}
      </section>
    </div>
  );
}
