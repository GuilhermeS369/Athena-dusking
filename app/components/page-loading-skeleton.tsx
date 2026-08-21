type PageLoadingSkeletonProps = {
  variant?: 'dashboard' | 'cards' | 'gallery' | 'logs' | 'form';
};

export default function PageLoadingSkeleton({ variant = 'dashboard' }: PageLoadingSkeletonProps) {
  const cardCount = variant === 'gallery' ? 8 : variant === 'logs' ? 6 : 4;

  return (
    <section className={`page-loading-skeleton page-loading-skeleton-${variant}`} aria-label="Carregando conteúdo" role="status">
      <header className="page-loading-heading">
        <div>
          <span className="skeleton-line skeleton-line-kicker" />
          <span className="skeleton-line skeleton-line-title" />
          <span className="skeleton-line skeleton-line-text" />
        </div>
        <span className="skeleton-pill" />
      </header>

      <section className="panel page-loading-toolbar" aria-hidden="true">
        <span className="skeleton-input" />
        <span className="skeleton-input skeleton-input-short" />
        <span className="skeleton-input skeleton-input-short" />
      </section>

      <section className="page-loading-grid" aria-hidden="true">
        {Array.from({ length: cardCount }, (_, index) => (
          <article className="panel page-loading-card" key={index}>
            <span className="skeleton-line skeleton-line-kicker" />
            <span className="skeleton-line skeleton-line-subtitle" />
            <span className="skeleton-line skeleton-line-text" />
            <span className="skeleton-line skeleton-line-text skeleton-line-short" />
          </article>
        ))}
      </section>
    </section>
  );
}
