import { useEffect, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { getRssWorkerBaseUrl } from '../services/newsService';
import { TOPIC_META } from './TopicFilter';

/** Resolve image hrefs against the article page so relative paths are not loaded from the SPA origin. */
function resolveArticleImageUrl(raw: string, articlePageUrl: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith('?') || t.startsWith('&')) return undefined;
  try {
    const u = new URL(t, articlePageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Lazy og:image via Cloudflare Worker (`GET /og-image`) — no third-party CORS proxies. */
async function fetchOGImage(articlePageUrl: string): Promise<string | undefined> {
  const signal = AbortSignal.timeout(10000);
  const base = getRssWorkerBaseUrl();
  const res = await fetch(
    `${base}/og-image?url=${encodeURIComponent(articlePageUrl)}`,
    { signal },
  );
  if (!res.ok) return undefined;
  const d = (await res.json()) as { imageUrl: string | null };
  if (!d.imageUrl) return undefined;
  return resolveArticleImageUrl(d.imageUrl, articlePageUrl) ?? d.imageUrl;
}

function useLazyOGImage(articleUrl: string, existingImage?: string) {
  const [lazyImg, setLazyImg] = useState<string | undefined>(undefined);
  const [imgFailed, setImgFailed] = useState(false);
  const cardRef = useRef<HTMLElement>(null);

  // Fetch og:image when: no RSS image at all, OR the RSS image failed to load.
  const shouldFetch = !existingImage || imgFailed;

  useEffect(() => {
    if (!shouldFetch) return;
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      entries => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();
        fetchOGImage(articleUrl).then(img => {
          if (img) setLazyImg(img);
        }).catch(() => {});
      },
      { rootMargin: '400px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [articleUrl, shouldFetch]);

  const raw = imgFailed ? lazyImg : (existingImage ?? lazyImg);
  const imageUrl = raw ? resolveArticleImageUrl(raw, articleUrl) : undefined;
  return { cardRef, imageUrl, onImageError: () => setImgFailed(true) };
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
  onUpvote: (article: Article) => void;
  onDownvote: (article: Article) => void;
}

export function ArticleCard({ article, prefs, onOpen, onSave, onUpvote, onDownvote }: Props) {
  const saved     = prefs.savedIds.includes(article.id);
  const votedUp   = prefs.upvotedIds.includes(article.id);
  const votedDown = prefs.downvotedIds.includes(article.id);

  const [dismissed, setDismissed] = useState(false);

  const primaryTopic = article.topics[0];
  const topicMeta    = TOPIC_META[primaryTopic];
  const isVideo      = article.imageUrl?.includes('img.youtube.com');

  const { cardRef, imageUrl, onImageError } = useLazyOGImage(article.url, article.imageUrl);

  const handleDownvote = () => {
    setDismissed(true);
    // Small delay so the fade-out animation plays before React removes the card
    setTimeout(() => onDownvote(article), 280);
  };

  const handleUpvote = () => {
    onUpvote(article);
  };

  return (
    <article
      className={`card ${dismissed ? 'card-dismissed' : ''}`}
      ref={cardRef as React.RefObject<HTMLElement>}
    >
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
            onError={() => onImageError()}
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

          <div className="card-vote-group">
            <button
              className={`btn-vote btn-upvote ${votedUp ? 'active' : ''}`}
              onClick={handleUpvote}
              aria-label="More like this"
              title="More like this"
            >
              ▲
            </button>
            <button
              className={`btn-vote btn-downvote ${votedDown ? 'active' : ''}`}
              onClick={handleDownvote}
              aria-label="Less like this"
              title="Less like this"
            >
              ▼
            </button>
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
      </div>
    </article>
  );
}
