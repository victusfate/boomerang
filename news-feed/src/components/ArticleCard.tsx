import { useEffect, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { TOPIC_META } from './TopicFilter';

const OG_REGEX =
  /property=["']og:image["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image["']/i;

// Try both CORS proxies; return the first og:image found, or undefined.
async function fetchOGImage(url: string): Promise<string | undefined> {
  const signal = AbortSignal.timeout(10000);

  const tryPrimary = fetch(
    `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal }
  ).then(r => r.json()).then((d: { contents?: string }) => {
    const m = d.contents?.match(OG_REGEX);
    const img = m?.[1] ?? m?.[2];
    if (!img) throw new Error('no og:image');
    return img;
  });

  const tryFallback = fetch(
    `https://corsproxy.io/?${encodeURIComponent(url)}`, { signal }
  ).then(r => r.text()).then(html => {
    const m = html.match(OG_REGEX);
    const img = m?.[1] ?? m?.[2];
    if (!img) throw new Error('no og:image');
    return img;
  });

  // Return whichever resolves first; if both fail, return undefined.
  return new Promise<string | undefined>(resolve => {
    let failures = 0;
    const fail = () => { if (++failures === 2) resolve(undefined); };
    tryPrimary.then(resolve).catch(fail);
    tryFallback.then(resolve).catch(fail);
  });
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
        fetchOGImage(articleUrl).then(img => { if (img) setLazyImg(img); }).catch(() => {});
      },
      { rootMargin: '400px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [articleUrl, shouldFetch]);

  const imageUrl = imgFailed ? lazyImg : (existingImage ?? lazyImg);
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
