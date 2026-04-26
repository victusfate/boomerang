# Ubiquitous language — fast-initial-fetch

| Term | Definition |
|------|------------|
| **Fast batch** | First network fetch path: only built-in sources with `priority: 1` (among enabled, non-YouTube queue rules unchanged unless called out in PRD). Produces the smallest `/bundle?include=…` needed for first paint. |
| **Background batch** | Second path: built-in `priority: 2` **plus** all **custom (OPML) sources**. May run in parallel with the fast batch (v1). |
| **Fetch tier** | Metadata on articles (or implied from source at rank time) distinguishing **fast-tier** vs **background-tier** for scoring and merge. Custom sources are always **background-tier** in v1. |
| **Source priority** | Field on built-in `NewsSource` in `shared/rss-sources.json`: `1` = fast batch, `2` = background batch. (Not the React `fetchPriority` / image `priority` in `ArticleCard`.) |
| **Merge anchor** | After the fast batch renders, the ordered list of article ids the user is already reading; background-tier results must not insert *above* that anchor; combined with **tier penalty** in ranking. |
| **Tier penalty** | A multiplicative or additive adjustment in ranking so background-tier articles sort **below** fast-tier content when re-ranking the combined pool, preventing “jumps” above already shown cards. |
| **Worker bundle** | `GET /bundle?include=…&customFeeds=…` on the Cloudflare RSS worker; two logical calls in parallel for v1. |

**Ambiguity resolved:** “Priority” in UI code (`priority` on first card image) is unrelated; use **source priority** or **fetch tier** in docs and code for this feature.
