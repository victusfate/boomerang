import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { loadRecStats } from '../services/recStats';
import {
  fetchRecArticles,
  fetchRecDiagnostics,
  type RecArticlesResponse,
  type RecDebugInfo,
  type RecResponseWithScores,
} from '../services/recWorker';
import { PLATFORM_WORKER_URL } from '../config/workerEnv';
import type { RecStatus } from '../hooks/useRecWorker';
import { RecModelInfo }  from './rec/RecModelInfo';
import { RecTraceView, buildSourceEntries, buildTopicEntries, buildTagEntries } from './rec/RecTraceView';
import { RecScoreTable } from './rec/RecScoreTable';

const TOP_N = 25;

interface Props {
  recUserId?: string | null;
  recArticleIds: string[];
  recScoreById: Record<string, number>;
  recScoredArticles: RecResponseWithScores['scoredArticleIds'];
  recModelDiagnostics: RecResponseWithScores['diagnostics'] | null;
  recTrace: RecResponseWithScores['trace'] | null;
  recCacheInfo: RecResponseWithScores['cache'] | null;
  recTimingMs: RecResponseWithScores['timingMs'] | null;
  recGeneratedAt: number | null;
  recStatus: RecStatus;
  getSourceName: (sourceId: string) => string;
  getArticleTitle: (id: string) => string | null;
}

interface DiagData {
  stats: Awaited<ReturnType<typeof loadRecStats>>;
  debug: RecDebugInfo | null;
}

function formatModelAge(generatedAt: number | null): string {
  if (!generatedAt) return 'unknown';
  const deltaMs = Date.now() - generatedAt;
  if (deltaMs < 0) return 'just now';
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function RecUserIdBar({ userId }: { userId: string | null | undefined }) {
  const [copied, setCopied] = useState(false);

  const copyId = useCallback(async () => {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [userId]);

  return (
    <div
      className="rec-user-id-bar rec-user-id-bar--footer"
      title="Collaborative filtering user id — used for /recommendations/:userId and /interactions"
    >
      <span className="rec-user-id-label">User id</span>
      <code
        className="rec-user-id-value"
        onClick={() => { void copyId(); }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyId();
          }
        }}
        role="button"
        tabIndex={userId ? 0 : -1}
        aria-label={userId ? `Recommendation user id ${userId}, click to copy` : 'Recommendation user id loading'}
      >
        {userId ?? 'Loading…'}
      </code>
      <button
        type="button"
        className="rec-user-id-copy"
        onClick={() => { void copyId(); }}
        disabled={!userId}
        aria-label="Copy recommendation user id"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function RecDiagnostics({
  recUserId,
  recArticleIds,
  recScoreById,
  recScoredArticles,
  recModelDiagnostics,
  recTrace,
  recCacheInfo,
  recTimingMs,
  recGeneratedAt,
  recStatus,
  getSourceName,
  getArticleTitle,
}: Props) {
  const [data, setData]       = useState<DiagData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lookupTitleById, setLookupTitleById] = useState<Record<string, string>>({});
  const [lookupCoverage, setLookupCoverage] = useState<Pick<RecArticlesResponse, 'found' | 'requested' | 'missing' | 'timingMs'> | null>(null);
  const settledLookupIdsRef  = useRef(new Set<string>());
  const inFlightLookupKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stats, debug] = await Promise.all([
        loadRecStats(),
        PLATFORM_WORKER_URL
          ? fetchRecDiagnostics(PLATFORM_WORKER_URL).catch(() => null)
          : Promise.resolve(null),
      ]);
      setData({ stats, debug });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const topRated = useMemo(() => {
    if (recScoredArticles.length > 0) {
      return [...recScoredArticles]
        .sort((a, b) => b.score - a.score || a.articleId.localeCompare(b.articleId))
        .slice(0, TOP_N)
        .map((row, idx) => ({ id: row.articleId, rank: idx + 1, score: row.score }));
    }
    return recArticleIds
      .map(id => ({ id, score: recScoreById[id] }))
      .filter((row): row is { id: string; score: number } =>
        typeof row.score === 'number' && Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, TOP_N)
      .map((row, idx) => ({ ...row, rank: idx + 1 }));
  }, [recScoredArticles, recArticleIds, recScoreById]);

  const titleLookupKey = useMemo(() => topRated.map(r => r.id).join(','), [topRated]);

  useEffect(() => {
    if (!titleLookupKey || !PLATFORM_WORKER_URL) return;
    const ids = titleLookupKey.split(',').filter(Boolean);
    const missingIds = ids.filter(
      id => !getArticleTitle(id)
        && !lookupTitleById[id]
        && !settledLookupIdsRef.current.has(id),
    );
    if (missingIds.length === 0) return;

    const batchKey = missingIds.slice().sort().join(',');
    if (inFlightLookupKeyRef.current === batchKey) return;
    inFlightLookupKeyRef.current = batchKey;

    void fetchRecArticles(PLATFORM_WORKER_URL, missingIds)
      .then((response) => {
        inFlightLookupKeyRef.current = null;
        for (const id of missingIds) settledLookupIdsRef.current.add(id);
        setLookupCoverage({
          found: response.found,
          requested: response.requested,
          missing: response.missing,
          timingMs: response.timingMs,
        });
        if (response.articles.length > 0) {
          setLookupTitleById(prev => ({
            ...prev,
            ...Object.fromEntries(response.articles.map(a => [a.id, a.title])),
          }));
        }
      })
      .catch(() => {
        inFlightLookupKeyRef.current = null;
        for (const id of missingIds) settledLookupIdsRef.current.add(id);
      });
  }, [titleLookupKey, getArticleTitle, lookupTitleById]);

  const scoreValues = topRated.map(e => e.score);
  const minScore    = scoreValues.length > 0 ? Math.min(...scoreValues) : 0;
  const maxScore    = scoreValues.length > 0 ? Math.max(...scoreValues) : 1;
  const scoreSpan   = maxScore - minScore;

  const { sourceEntries, topicEntries, tagEntries, maxSource, maxTopic, maxTag } = useMemo(() => {
    if (!data) {
      return {
        sourceEntries: [] as ReturnType<typeof buildSourceEntries>,
        topicEntries:  [] as { topic: string; score: number }[],
        tagEntries:    [] as { tag: string; score: number }[],
        maxSource: 1, maxTopic: 1, maxTag: 1,
      };
    }
    const se = buildSourceEntries(data.stats.sources, getSourceName);
    const te = buildTopicEntries(data.stats.topics);
    const ue = buildTagEntries(data.stats.tags);
    return {
      sourceEntries: se, topicEntries: te, tagEntries: ue,
      maxSource: se[0] ? Math.abs(se[0].score) : 1,
      maxTopic:  te[0]?.score || 1,
      maxTag:    ue[0]?.score || 1,
    };
  }, [data, getSourceName]);

  const previewIds = topRated.map(e => e.id);
  const resolvedTitleCount = previewIds.filter(
    id => Boolean(getArticleTitle(id) || lookupTitleById[id]),
  ).length;
  const titleLookupHint = lookupCoverage
    ? `Resolved ${resolvedTitleCount}/${previewIds.length} titles`
      + (lookupCoverage.missing.length > 0 ? ` (${lookupCoverage.missing.length} missing)` : '')
      + (lookupCoverage.timingMs ? ` · ${Math.round(lookupCoverage.timingMs.total)}ms` : '')
    : previewIds.length > 0
      ? `Resolved ${resolvedTitleCount}/${previewIds.length} titles`
      : null;

  const statusDot  = recStatus === 'active' ? 'active' : recStatus === 'error' ? 'error' : 'idle';
  const coldLabel  = recModelDiagnostics?.coldStart ? ' · cold start' : '';

  if (loading && !data) {
    return (
      <div className="rec-diag">
        <div className="rec-diag-main">
          <p className="settings-hint">Loading ranking diagnostics…</p>
        </div>
        <RecUserIdBar userId={recUserId} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rec-diag">
        <div className="rec-diag-main">
          <p className="sync-error">{error}</p>
          <button type="button" className="btn-add-source" onClick={() => { void load(); }}>Retry</button>
        </div>
        <RecUserIdBar userId={recUserId} />
      </div>
    );
  }

  return (
    <div className="rec-diag">
      <div className="rec-diag-main">
        <div className="rec-status-row">
          <span className={`sync-dot sync-dot--${statusDot}`} />
          <span className="settings-hint" style={{ margin: 0 }}>
            {data?.debug
              ? `${data.debug.interactionsCount.count.toLocaleString()} remote interactions`
              : data
                ? `${data.stats.total.toLocaleString()} local interactions`
                : '—'}
          </span>
          <span className="rec-status-sep" />
          <span className="settings-hint" style={{ margin: 0 }}>
            {topRated.length > 0
              ? `Top ${topRated.length} by MF score`
              : recArticleIds.length > 0
                ? `${recArticleIds.length} ranked`
                : recStatus === 'active' ? 'Waiting for rankings…' : 'Ranking offline'}
            {recModelDiagnostics?.candidateCount != null && topRated.length > 0
              ? ` · ${recModelDiagnostics.candidateCount} candidates`
              : ''}
            {coldLabel}
          </span>
          <span className="rec-status-sep" />
          <span className="settings-hint" style={{ margin: 0 }}>
            Model {formatModelAge(recGeneratedAt)}
          </span>
          <button
            type="button"
            className="rec-diag-reload"
            onClick={() => { void load(); }}
            title="Refresh local stats &amp; model info"
            disabled={loading}
          >
            ↺
          </button>
        </div>

        <RecModelInfo
          recModelDiagnostics={recModelDiagnostics}
          recCacheInfo={recCacheInfo}
          recTimingMs={recTimingMs}
          recTrace={recTrace}
        />

        <RecTraceView
          sourceEntries={sourceEntries}
          topicEntries={topicEntries}
          tagEntries={tagEntries}
          maxSource={maxSource}
          maxTopic={maxTopic}
          maxTag={maxTag}
          debug={data?.debug ?? null}
          hasData={Boolean(data)}
        />

        <RecScoreTable
          topRated={topRated}
          minScore={minScore}
          maxScore={maxScore}
          scoreSpan={scoreSpan}
          getArticleTitle={getArticleTitle}
          lookupTitleById={lookupTitleById}
          titleLookupHint={titleLookupHint}
          recStatus={recStatus}
        />
      </div>

      <RecUserIdBar userId={recUserId} />
    </div>
  );
}
