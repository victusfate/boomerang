import type { Article, UserPrefs } from '../types';
import { TOPIC_META } from './TopicFilter';

function timeAgo(date: Date): string {
  const secs = (Date.now() - date.getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface Props {
  article: Article;
  prefs: UserPrefs;
  onOpen: (article: Article) => void;
  onSave: (id: string) => void;
}

export function ArticleCard({ article, prefs, onOpen, onSave }: Props) {
  const saved = prefs.savedIds.includes(article.id);
  const primaryTopic = article.topics[0];
  const topicMeta = TOPIC_META[primaryTopic];

  return (
    <article className="card">
      {article.imageUrl && (
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="card-image-link"
          onClick={() => onOpen(article)}
        >
          <img
            src={article.imageUrl}
            alt=""
            className="card-image"
            loading="lazy"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </a>
      )}

      <div className="card-body">
        <div className="card-meta">
          <span className="card-source">{article.source}</span>
          <span className="card-dot">·</span>
          <span className="card-time">{timeAgo(article.publishedAt)}</span>
          <span className="card-dot">·</span>
          <span className="card-topic" style={{ color: topicMeta?.color }}>
            {topicMeta?.label ?? primaryTopic}
          </span>
        </div>

        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="card-title-link"
          onClick={() => onOpen(article)}
        >
          <h2 className="card-title">{article.title}</h2>
        </a>

        {article.description && (
          <p className="card-desc">{article.description}</p>
        )}

        <div className="card-actions">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-read"
            onClick={() => onOpen(article)}
          >
            Read →
          </a>
          <button
            className={`btn-save ${saved ? 'saved' : ''}`}
            onClick={() => onSave(article.id)}
            aria-label={saved ? 'Remove bookmark' : 'Bookmark'}
            title={saved ? 'Remove bookmark' : 'Bookmark'}
          >
            {saved ? '★' : '☆'}
          </button>
        </div>
      </div>
    </article>
  );
}
