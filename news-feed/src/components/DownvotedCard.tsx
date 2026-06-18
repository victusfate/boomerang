import type { Article } from '../types';

interface Props {
  article: Article;
  animateEnter: boolean;
  navUrl: string;
  cardRef: React.RefObject<HTMLElement | null>;
  onDownvote: (article: Article) => void;
  onArticleNavClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

export function DownvotedCard({ article, animateEnter, navUrl, cardRef, onDownvote, onArticleNavClick }: Props) {
  return (
    <article
      className={`card card-downvoted${animateEnter ? ' card-enter' : ''}`}
      ref={cardRef as React.RefObject<HTMLElement>}
    >
      <div className="card-body card-body-collapsed">
        <div className="card-collapsed-row">
          <span className="card-source card-source-muted">{article.source}</span>
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="card-collapsed-title"
            onClick={onArticleNavClick}
          >
            {article.title}
          </a>
          <button
            className="btn-vote btn-downvote active"
            onClick={() => onDownvote(article)}
            aria-label="Remove downvote"
            title="Show again"
          >
            ▼
          </button>
        </div>
      </div>
    </article>
  );
}
