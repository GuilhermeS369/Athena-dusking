'use client';

import { useState } from 'react';

import type { AuthMirrorLinkState } from '@/lib/auth/mirror-link';

function formatDate(value: string | null) {
  if (!value) return '—';

  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Link espelho de login. Ficava na tela de Perfis, que é operacional e usada o
 * dia inteiro; um acesso que entrega a sessão inteira a quem tiver a URL não
 * pertence ali. Agora vive em Administração e exige papel de admin — operador
 * não gera mais link.
 */
export default function MirrorLinkClient({
  authMirrorLink: initialAuthMirrorLink,
}: {
  authMirrorLink: AuthMirrorLinkState;
}) {
  const [authMirrorLink, setAuthMirrorLink] = useState(initialAuthMirrorLink);
  const [authMirrorUrl, setAuthMirrorUrl] = useState('');
  const [authMirrorBusy, setAuthMirrorBusy] = useState(false);
  const [authMirrorMessage, setAuthMirrorMessage] = useState('');

  async function copyAuthMirrorUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  async function activateAuthMirrorLink() {
    setAuthMirrorBusy(true);
    setAuthMirrorMessage('');

    try {
      const response = await fetch('/api/auth/mirror-link', { method: 'POST' });
      const payload = await response.json() as { mirrorLink?: AuthMirrorLinkState; mirrorUrl?: string; error?: string };

      if (!response.ok || !payload.mirrorLink || !payload.mirrorUrl) {
        setAuthMirrorMessage(payload.error ?? 'Não foi possível ativar o link espelho.');
        return;
      }

      setAuthMirrorLink(payload.mirrorLink);
      setAuthMirrorUrl(payload.mirrorUrl);
      const copied = await copyAuthMirrorUrl(payload.mirrorUrl);
      setAuthMirrorMessage(copied ? 'Link espelho ativado e copiado.' : 'Link espelho ativado. Copie o link para usar nos aparelhos.');
    } catch {
      setAuthMirrorMessage('Não foi possível conectar ao servidor.');
    } finally {
      setAuthMirrorBusy(false);
    }
  }

  async function deactivateAuthMirrorLink() {
    if (!window.confirm('Desativar o link espelho atual? Quem usar esse link será enviado para o login.')) return;

    setAuthMirrorBusy(true);
    setAuthMirrorMessage('');

    try {
      const response = await fetch('/api/auth/mirror-link', { method: 'DELETE' });
      const payload = await response.json() as { mirrorLink?: AuthMirrorLinkState; error?: string };

      if (!response.ok || !payload.mirrorLink) {
        setAuthMirrorMessage(payload.error ?? 'Não foi possível desativar o link espelho.');
        return;
      }

      setAuthMirrorLink(payload.mirrorLink);
      setAuthMirrorUrl('');
      setAuthMirrorMessage('Link espelho desativado.');
    } catch {
      setAuthMirrorMessage('Não foi possível conectar ao servidor.');
    } finally {
      setAuthMirrorBusy(false);
    }
  }

  return (
    <section
      className={`panel profile-mirror-login-panel${authMirrorLink.active ? ' profile-mirror-login-panel-active' : ' profile-mirror-login-panel-inactive'}`}
      aria-label="Link espelho de login"
    >
      <div className="profile-mirror-login-copy">
        <span className="section-kicker">Acesso administrativo</span>
        <h2>Link espelho para aparelhos limpos</h2>
        <p>Ative um link temporário para abrir em celulares ou computadores sem sessão. Enquanto estiver ativo, quem usar o link entra como você e cai direto em Perfis.</p>
        {authMirrorLink.active ? (
          <p className="profile-mirror-login-warning">Quem tiver esse link acessa com suas permissões até você desativar.</p>
        ) : (
          <p className="profile-mirror-login-note">Nenhum link ativo agora. Ative somente quando for usar em um aparelho limpo, e desative logo depois.</p>
        )}
      </div>
      <div className={`profile-mirror-login-controls${authMirrorLink.active ? '' : ' profile-mirror-login-controls-inactive'}`}>
        <div className="profile-mirror-login-status-row">
          <span className={authMirrorLink.active ? 'profile-mirror-login-status active' : 'profile-mirror-login-status'}>
            <span aria-hidden="true" />{authMirrorLink.active ? 'Ativo' : 'Inativo'}
          </span>
          <button
            className={authMirrorLink.active ? 'profile-mirror-switch profile-mirror-switch-on' : 'profile-mirror-switch'}
            type="button"
            role="switch"
            aria-checked={authMirrorLink.active}
            disabled={authMirrorBusy}
            onClick={() => authMirrorLink.active ? void deactivateAuthMirrorLink() : void activateAuthMirrorLink()}
          >
            <span aria-hidden="true" />
            <strong>{authMirrorLink.active ? 'Desativar' : 'Ativar link'}</strong>
          </button>
        </div>
        {!authMirrorLink.active && <p className="profile-mirror-inactive-summary">Ao ativar, o link será gerado e copiado automaticamente para você enviar ao aparelho.</p>}
        {authMirrorLink.active && (
          <dl className="profile-mirror-login-meta">
            <div><dt>Gerado por</dt><dd>{authMirrorLink.createdByEmail ?? '—'}</dd></div>
            <div><dt>Usos</dt><dd>{authMirrorLink.useCount}</dd></div>
            <div><dt>Último uso</dt><dd>{formatDate(authMirrorLink.lastUsedAt)}</dd></div>
          </dl>
        )}
        {authMirrorUrl ? (
          <div className="profile-mirror-link-box">
            <input value={authMirrorUrl} readOnly aria-label="Link espelho ativo" onFocus={(event) => event.currentTarget.select()} />
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void copyAuthMirrorUrl(authMirrorUrl).then((copied) => setAuthMirrorMessage(copied ? 'Link copiado.' : 'Não foi possível copiar automaticamente. Selecione e copie o campo.'))}
            >
              Copiar link
            </button>
          </div>
        ) : authMirrorLink.active ? (
          <div className="profile-mirror-hidden-link">
            <span>O link está ativo, mas só é exibido no momento em que é gerado.</span>
            <button className="button button-ghost" type="button" disabled={authMirrorBusy} onClick={() => void activateAuthMirrorLink()}>
              Gerar novo link
            </button>
          </div>
        ) : null}
        {authMirrorMessage && <p className="profile-mirror-login-message" role="status">{authMirrorMessage}</p>}
      </div>
    </section>
  );
}
