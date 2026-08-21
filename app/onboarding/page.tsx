'use client';

import { FormEvent, useState } from 'react';

export default function OnboardingPage() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage('');

    try {
      const response = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slug }),
      });
      const result = await response.json() as { error?: string };

      if (!response.ok) {
        setMessage(result.error ?? 'Não foi possível criar a organização.');
        return;
      }

      window.location.assign('/');
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="onboarding-title">
        <div className="brand-block auth-brand">
          <div className="brand-mark" aria-hidden="true">✧</div>
          <div>
            <span className="eyebrow">Athena</span>
            <strong>Primeiro workspace</strong>
          </div>
        </div>

        <div className="auth-heading">
          <span className="section-kicker">Organização</span>
          <h1 id="onboarding-title">Crie seu workspace</h1>
          <p>A organização separa perfis, mídias, filas, agendas e permissões dos seus clientes.</p>
        </div>

        <form className="auth-form" onSubmit={createOrganization}>
          <label htmlFor="organization-name">Nome da organização</label>
          <input
            id="organization-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Agência Aurora"
            minLength={2}
            maxLength={120}
            required
          />

          <label htmlFor="organization-slug">Identificador</label>
          <input
            id="organization-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="agencia-aurora"
            maxLength={80}
            pattern="[a-zA-Z0-9-]+"
            aria-describedby="slug-help"
          />
          <small id="slug-help" className="field-help">Pode deixar vazio para gerar a partir do nome.</small>

          <button className="button button-secondary full-width" disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Criando...' : 'Criar organização'}
          </button>
        </form>

        {message && <p className="auth-message" role="alert">{message}</p>}
        <p className="auth-note">O primeiro membro recebe o papel Administrador.</p>
      </section>
    </main>
  );
}
