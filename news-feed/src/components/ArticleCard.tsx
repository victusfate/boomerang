import { useMemo, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { TOPIC_META } from './topicFilterUtils';
import { CardScoreBadge } from './CardScoreBadge';
import { TagEditor }      from './TagEditor';
import { DownvotedCard }  from './DownvotedCard';
import { useArticleDwell } from '../hooks/useArticleDwell';
import type { FeedScoreInsight } from '../services/feedScoreBreakdown';
import { timeAgo } from '../services/timeAgo';
import { normalizeArticleNavUrl } from '../services/articleNavUrl';

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
  /** Feed tab: local + MF ranking breakdown (hover chip) */
  feedScoreInsight?: FeedScoreInsight | null;
  feedScoresLoading?: boolean;
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
  feedScoreInsight,
  feedScoresLoading = false,
}: Props) {
  const saved     = prefs.savedIds.includes(article.id);
  const votedUp   = prefs.upvotedIds.includes(article.id);
  const votedDown = prefs.downvotedIds.includes(article.id);

  const primaryTopic = article.topics[0];
  const topicMeta    = TOPIC_META[primaryTopic];
  const navUrl       = useMemo(() => normalizeArticleNavUrl(article.url), [article.url]);
  const discussionNavUrl = useMemo(
    () => (article.discussionUrl ? normalizeArticleNavUrl(article.discussionUrl) : ''),
    [article.discussionUrl],
  );
  const isVideo =
    article.imageUrl?.includes('img.youtube.com') === true
    || /youtube\.com|youtu\.be/i.test(navUrl);

  const cardRef = useRef<HTMLElement>(null);
  const [imgFailed, setImgFailed] = useState(false);
  // Prefer RSS image; if it fails fall back to og:image from batch hook
  const imageUrl = imgFailed ? (ogImageUrl ?? undefined) : (article.imageUrl ?? ogImageUrl ?? undefined);

  const uniqueLabelNames = useMemo(
    () => Array.from(new Set(articleLabelNames)),
    [articleLabelNames],
  );

  useArticleDwell(article.id, cardRef, onSeen);

  /** Defer prefs so re-rank does not cancel navigation. */
  const deferMarkOpen = () => { window.setTimeout(() => onOpen(article), 0); };

  const handleArticleNavClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0) return;
    if (!navUrl) { e.preventDefault(); return; } // invalid stored URL — don't open a blank tab
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) { deferMarkOpen(); return; }
    e.preventDefault();
    window.open(navUrl, '_blank', 'noopener,noreferrer');
    deferMarkOpen();
  };

  if (votedDown) {
    return (
      <DownvotedCard
        article={article}
        animateEnter={animateEnter}
        navUrl={navUrl}
        cardRef={cardRef}
        onDownvote={onDownvote}
        onArticleNavClick={handleArticleNavClick}
      />
    );
  }

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
          {(feedScoresLoading || feedScoreInsight) && (
            <>
              <span className="card-dot">·</span>
              <CardScoreBadge insight={feedScoreInsight ?? null} loading={feedScoresLoading} />
            </>
          )}
        </div>

        {(uniqueLabelNames.length > 0 || onAddManualTag) && (
          <TagEditor
            articleId={article.id}
            uniqueLabelNames={uniqueLabelNames}
            onAddManualTag={onAddManualTag}
            onRemoveManualTag={onRemoveManualTag}
          />
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
            {discussionNavUrl && (
              <a
                href={discussionNavUrl}
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
