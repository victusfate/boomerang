import { useEffect, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { TOPIC_META } from './TopicFilter';

const OG_REGEX =
  /property=["']og:image["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image["']/i;

// Lazily fetches og:image for the article when the card scrolls into view.
// Skips the fetch if the article already has an image from the RSS feed.
function useLazyOGImage(articleUrl: string, existingImage?: string) {
  const [lazyImg, setLazyImg] = useState<string | undefined>(undefined);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (existingImage) return;
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      entries => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();

        fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(articleUrl)}`, {
          signal: AbortSignal.timeout(8000),
        })
          .then(r => r.json())
          .then((data: { contents: string }) => {
            const m = data.contents?.match(OG_REGEX);
            const img = m?.[1] ?? m?.[2];
            if (img) setLazyImg(img);
          })
          .catch(() => {});
      },
      { rootMargin: '400px' }, // fetch before the card is fully visible
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [articleUrl, existingImage]);

  return { cardRef, imageUrl: existingImage ?? lazyImg };
}

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
  const isVideo = article.imageUrl?.includes('img.youtube.com');

  const { cardRef, imageUrl } = useLazyOGImage(article.url, article.imageUrl);

  return (
    <article className="card" ref={cardRef as React.RefObject<HTMLElement>}>
      {imageUrl && (
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="card-image-link"
          onClick={() => onOpen(article)}
        >
          <img
            src={imageUrl}
            alt=""
            className="card-image"
            loading="lazy"
            onError={e => { (e.target as HTMLImageElement).closest('.card-image-link')?.remove(); }}
          />
          {isVideo && (
            <span className="card-play-btn" aria-label="Play video">▶</span>
          )}
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
            {isVideo ? 'Watch →' : 'Read →'}
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
