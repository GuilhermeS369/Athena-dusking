'use client';

import { FormEvent, Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
  const mirrorMessage = searchParams.get('mirror') === 'revoked'
    ? 'O link espelho foi desativado. Entre manualmente para continuar.'
    : searchParams.get('mirror') === 'invalid'
      ? 'O link espelho é inválido. Entre manualmente para continuar.'
      : searchParams.get('mirror') === 'error'
        ? 'Não foi possível validar o link espelho agora. Entre manualmente para continuar.'
        : '';

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

      window.location.assign('/');
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
          <div className="brand-mark" aria-hidden="true">✧</div>
          <div>
            <span className="eyebrow">Athena</span>
            <strong>Scheduler</strong>
          </div>
        </div>

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
