'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

function describeAuthError(error: { message?: string; code?: string; status?: number }) {
  const message = error.message?.toLowerCase() ?? '';

  if (message.includes('invalid login credentials')) {
    return 'E-mail ou senha incorretos.';
  }

  if (message.includes('email not confirmed')) {
    return 'Confirme seu e-mail antes de entrar.';
  }

  if (message.includes('too many requests')) {
    return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  }

  if (message.includes('failed to fetch') || message.includes('network')) {
    return 'Não foi possível conectar ao serviço de autenticação. Verifique sua internet e tente novamente.';
  }

  return error.code
    ? `Não foi possível entrar (${error.code}).`
    : 'Não foi possível entrar. Verifique os dados e tente novamente.';
}

function LoginContent() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [isSettingPassword, setIsSettingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const mirrorMessage = searchParams.get('mirror') === 'revoked'
    ? 'O link espelho foi desativado. Entre manualmente para continuar.'
    : searchParams.get('mirror') === 'invalid'
      ? 'O link espelho é inválido. Entre manualmente para continuar.'
      : searchParams.get('mirror') === 'error'
        ? 'Não foi possível validar o link espelho agora. Entre manualmente para continuar.'
        : '';

  // O link de "Esqueci minha senha" volta para cá. Só a recuperação manda
  // `code` (ou `type=recovery` no hash) para /login, então a URL decide o modo
  // antes de o cliente existir — ele consome esses parâmetros ao ser criado.
  // A sessão que já estava aberta no navegador não conta: definir senha sem
  // informar a atual só vale para quem acabou de chegar pelo link do e-mail.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.slice(1));

    if (query.has('error_code') || hash.has('error_code')) {
      setMessage('O link de recuperação expirou ou já foi usado. Peça um novo em "Esqueci minha senha".');
      return;
    }
    if (!query.has('code') && hash.get('type') !== 'recovery') return;

    let supabase;
    try {
      supabase = createSupabaseBrowserClient();
    } catch {
      return;
    }

    let cancelled = false;
    let recovered = false;
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (cancelled || (event !== 'PASSWORD_RECOVERY' && event !== 'SIGNED_IN')) return;
      recovered = true;
      setMessage('');
      setIsSettingPassword(true);
    });
    // O evento sai num setTimeout depois da inicialização; a folga evita acusar
    // falha num link que acabou de ser aceito.
    void supabase.auth.getSession().then(() => setTimeout(() => {
      if (cancelled || recovered) return;
      setMessage('Não foi possível validar o link de recuperação. Abra-o no mesmo navegador em que pediu, ou peça um novo.');
    }, 1500));

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function handleNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');

    if (newPassword !== confirmPassword) {
      setMessage('A confirmação não é igual à nova senha.');
      return;
    }

    setIsSavingPassword(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({ password: newPassword });

      if (error) {
        setMessage(error.code === 'weak_password'
          ? 'A nova senha é fraca demais. Use uma senha mais longa, com letras e números.'
          : error.code === 'same_password'
            ? 'A nova senha precisa ser diferente da anterior.'
            : `Não foi possível salvar a nova senha${error.code ? ` (${error.code})` : ''}.`);
        return;
      }

      window.location.assign('/painel');
    } catch {
      setMessage('Não foi possível salvar a nova senha agora.');
    } finally {
      setIsSavingPassword(false);
    }
  }

  async function handlePasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage('');

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        setMessage(describeAuthError(error));
        return;
      }

      window.location.assign('/painel');
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message);
      } else {
        setMessage('Não foi possível iniciar o login. Tente novamente.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePasswordRecovery() {
    if (!email.trim()) {
      setMessage('Informe seu e-mail para receber o link de recuperação.');
      return;
    }

    setIsRecovering(true);
    setMessage('');
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`,
      });
      if (error) {
        setMessage(describeAuthError(error));
        return;
      }
      setMessage('Se existir uma conta com este e-mail, o link de recuperação foi enviado.');
    } catch {
      setMessage('Não foi possível solicitar a recuperação agora.');
    } finally {
      setIsRecovering(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="brand-block auth-brand">
          <div className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><use href="#icon-athena" /></svg></div>
          <div>
            <span className="eyebrow">Athena</span>
            <strong>Dusking</strong>
          </div>
        </div>

        {isSettingPassword ? (
          <>
            <div className="auth-heading">
              <span className="section-kicker">Recuperação de acesso</span>
              <h1 id="login-title">Defina a nova senha</h1>
              <p>Depois de salvar você entra direto no painel.</p>
            </div>

            <form className="auth-form" onSubmit={handleNewPassword}>
              <label htmlFor="new-password">Nova senha</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                aria-describedby="new-password-help"
                required
              />
              <small id="new-password-help" className="field-help">Pelo menos {MIN_PASSWORD_LENGTH} caracteres.</small>

              <label htmlFor="confirm-password">Confirmar nova senha</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />

              <button className="button button-secondary full-width" disabled={isSavingPassword} type="submit">
                {isSavingPassword ? 'Salvando…' : 'Salvar nova senha'}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="auth-heading">
              <span className="section-kicker">Acesso seguro</span>
              <h1 id="login-title">Entre na sua operação</h1>
              <p>Use o acesso recebido por convite para continuar no painel Athena.</p>
            </div>

            <form className="auth-form" onSubmit={handlePasswordLogin}>
              <label htmlFor="email">E-mail</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />

              <label htmlFor="password">Senha</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />

              <button className="button button-secondary full-width" disabled={isSubmitting} type="submit">
                {isSubmitting ? 'Entrando...' : 'Entrar'}
              </button>
              <button className="text-button" disabled={isRecovering || isSubmitting} type="button" onClick={handlePasswordRecovery}>
                {isRecovering ? 'Enviando link…' : 'Esqueci minha senha'}
              </button>
            </form>
          </>
        )}

        {(message || mirrorMessage) && <p className="auth-message" role="alert">{message || mirrorMessage}</p>}
        <p className="auth-note">O cadastro é controlado por convite da organização.</p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
