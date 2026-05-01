import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { Article, UserPrefs } from '../types';
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
  /** First visible card — eager image load */
  priority?: boolean;
  /** og:image fetched by the centralized batch hook; used when article has no RSS image */
  ogImageUrl?: string | null;
  /** AI-classified label names that apply to this article */
  articleLabelNames?: string[];
  onOpen: (article: Article) => void;
  onSave: (id: string) => void;
  onUpvote: (article: Article) => void;
  onDownvote: (article: Article) => void;
  onSeen?: (id: string) => void;
  /** True while Chrome AI is actively tagging this card */
  isTagging?: boolean;
  onAddManualTag?: (articleId: string, tag: string) => void;
  onRemoveManualTag?: (articleId: string, tag: string) => void;
}

export function ArticleCard({
  article,
  prefs,
  animateEnter = false,
  priority = false,
  ogImageUrl,
  articleLabelNames = [],
  isTagging = false,
  onOpen,
  onSave,
  onUpvote,
  onDownvote,
  onSeen,
  onAddManualTag,
  onRemoveManualTag,
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

  const cardRef = useRef<HTMLElement>(null);
  const [imgFailed, setImgFailed] = useState(false);
  // Prefer RSS image; if it fails fall back to og:image from batch hook
  const imageUrl = imgFailed ? (ogImageUrl ?? undefined) : (article.imageUrl ?? ogImageUrl ?? undefined);

  const [addingTag, setAddingTag] = useState(false);
  const [newTagText, setNewTagText] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);

  const commitNewTag = useCallback(() => {
    const v = newTagText.trim();
    if (v && onAddManualTag) onAddManualTag(article.id, v);
    setNewTagText('');
    setAddingTag(false);
  }, [newTagText, onAddManualTag, article.id]);

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commitNewTag(); }
    if (e.key === 'Escape') { setNewTagText(''); setAddingTag(false); }
  };

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
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : undefined}
            onError={() => setImgFailed(true)}
          />
          {isVideo && (
            <span className="card-play-btn" aria-label="Play video">▶</span>
          )}
        </a>
      )}

      <div className="card-body">
        <div className="card-meta">
          {isTagging && <span className="card-tagging-dot" aria-label="AI tagging in progress" title="AI tagging…" />}
          <span className="card-source">{article.source}</span>
          <span className="card-dot">·</span>
          <span className="card-time">{timeAgo(article.publishedAt)}</span>
          <span className="card-dot">·</span>
          <span className="card-topic" style={{ color: topicMeta?.color }}>
            {topicMeta?.label ?? primaryTopic}
          </span>
        </div>

        {(articleLabelNames.length > 0 || onAddManualTag) && (
          <div className="label-badges">
            {articleLabelNames.map(name => (
              <span key={name} className="label-badge">
                {name}
                {onRemoveManualTag && (
                  <button
                    className="label-badge-remove"
                    onClick={(e) => { e.stopPropagation(); onRemoveManualTag(article.id, name); }}
                    aria-label={`Remove tag ${name}`}
                  >×</button>
                )}
              </span>
            ))}
            {onAddManualTag && (
              addingTag ? (
                <input
                  ref={tagInputRef}
                  className="label-badge-input"
                  value={newTagText}
                  onChange={e => setNewTagText(e.target.value)}
                  onBlur={commitNewTag}
                  onKeyDown={handleTagInputKeyDown}
                  placeholder="tag…"
                  autoFocus
                  maxLength={30}
                />
              ) : (
                <button
                  className="label-badge-add"
                  onClick={() => setAddingTag(true)}
                  aria-label="Add tag"
                  title="Add tag"
                >+</button>
              )
            )}
          </div>
        )}

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
          <div className="card-read-group">
            <a
              href={navUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-read"
              onClick={handleArticleNavClick}
            >
              {isVideo ? 'Watch →' : 'Read →'}
            </a>
            {article.discussionUrl && (
              <a
                href={article.discussionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-discuss"
              >
                Comments →
              </a>
            )}
          </div>

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
