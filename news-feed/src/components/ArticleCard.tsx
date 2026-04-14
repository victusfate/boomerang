import { useEffect, useMemo, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { getRssWorkerBaseUrl } from '../services/newsService';
import { TOPIC_META } from './TopicFilter';

/** Match worker `normalizeHttpUrl` — fixes `&amp;` in stored URLs and canonicalizes for href / window.open. */
function normalizeArticleNavUrl(raw: string): string {
  let s = raw.trim();
  if (s.includes('&amp;')) s = s.replace(/&amp;/g, '&');
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw.trim();
    return u.href;
  } catch {
    return raw.trim();
  }
}

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

/** ms the card must be ≥50% visible before it counts as "seen" */
const DWELL_MS = 3_000;

interface Props {
  article: Article;
  prefs: UserPrefs;
  /** Short enter animation when appended during progressive refresh */
  animateEnter?: boolean;
  onOpen: (article: Article) => void;
  onSave: (id: string) => void;
  onUpvote: (article: Article) => void;
  onDownvote: (article: Article) => void;
  onSeen?: (id: string) => void;
}

export function ArticleCard({
  article,
  prefs,
  animateEnter = false,
  onOpen,
  onSave,
  onUpvote,
  onDownvote,
  onSeen,
}: Props) {
  const saved     = prefs.savedIds.includes(article.id);
  const votedUp   = prefs.upvotedIds.includes(article.id);
  const votedDown = prefs.downvotedIds.includes(article.id);

  const primaryTopic = article.topics[0];
  const topicMeta    = TOPIC_META[primaryTopic];
  const navUrl       = useMemo(() => normalizeArticleNavUrl(article.url), [article.url]);
  const isVideo =
    article.imageUrl?.includes('img.youtube.com') === true
    || /youtube\.com|youtu\.be/i.test(navUrl);

  const { cardRef, imageUrl, onImageError } = useLazyOGImage(navUrl, article.imageUrl);

  // Mark as seen after DWELL_MS of ≥50% visibility
  useEffect(() => {
    if (!onSeen) return;
    const el = cardRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!timer) timer = setTimeout(() => { onSeen(article.id); timer = null; }, DWELL_MS);
      } else {
        if (timer) { clearTimeout(timer); timer = null; }
      }
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [article.id, onSeen]); // cardRef is stable — excluded intentionally

  /** Defer prefs so re-rank does not cancel navigation. */
  const deferMarkOpen = () => { window.setTimeout(() => onOpen(article), 0); };

  const handleArticleNavClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) { deferMarkOpen(); return; }
    e.preventDefault();
    window.open(navUrl, '_blank', 'noopener,noreferrer');
    deferMarkOpen();
  };

  // ── Collapsed view for downvoted articles ─────────────────────────────────────
  if (votedDown) {
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
              onClick={handleArticleNavClick}
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

  // ── Normal card ───────────────────────────────────────────────────────────────
  return (
    <article className={`card${animateEnter ? ' card-enter' : ''}`} ref={cardRef as React.RefObject<HTMLElement>}>
      {imageUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="card-image-link"
          onClick={handleArticleNavClick}
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
          href={navUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="card-title-link"
          onClick={handleArticleNavClick}
        >
          <h2 className="card-title">{article.title}</h2>
        </a>

        {article.description && (
          <p className="card-desc">{article.description}</p>
        )}

        <div className="card-actions">
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-read"
            onClick={handleArticleNavClick}
          >
            {isVideo ? 'Watch →' : 'Read →'}
          </a>

          <div className="card-vote-group">
            <button
              className={`btn-vote btn-upvote ${votedUp ? 'active' : ''}`}
              onClick={() => onUpvote(article)}
              aria-label={votedUp ? 'Remove upvote' : 'More like this'}
              title={votedUp ? 'Remove upvote' : 'More like this'}
            >
              ▲
            </button>
            <button
              className={`btn-vote btn-downvote ${votedDown ? 'active' : ''}`}
              onClick={() => onDownvote(article)}
              aria-label={votedDown ? 'Remove downvote' : 'Less like this'}
              title={votedDown ? 'Remove downvote' : 'Less like this'}
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
