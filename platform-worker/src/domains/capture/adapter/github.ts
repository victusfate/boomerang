import type { CaptureRecord } from '../types.ts';
import {
  HTTP_OK,
  HTTP_NOT_FOUND,
  HTTP_CONFLICT,
  HTTP_REDIRECT_MIN,
} from '../../../lib/http-status.ts';

export interface GithubConfig {
  owner: string;
  repo: string;
  path: string;
  branch: string;
}

const MAX_ATTEMPTS = 2;
const API_VERSION = '2022-11-28';

function authHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'boomerang-capture',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

function decodeBase64(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function entryLine(capture: CaptureRecord): string {
  const title = capture.title || capture.url;
  return `- [ ] ${title} — ${capture.url}  <!-- note: ${capture.note} | ts: ${capture.ts} -->`;
}

function appendEntry(existing: string, capture: CaptureRecord): string {
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  return `${prefix}${entryLine(capture)}\n`;
}

export async function appendToGithub(
  fetchFn: typeof fetch,
  pat: string,
  config: GithubConfig,
  capture: CaptureRecord,
): Promise<void> {
  const headers = authHeaders(pat);
  const contentsUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const getRes = await fetchFn(`${contentsUrl}?ref=${config.branch}`, { headers });

    let existing = '';
    let sha: string | undefined;
    if (getRes.status === HTTP_OK) {
      const file = (await getRes.json()) as { content: string; sha: string };
      existing = decodeBase64(file.content);
      sha = file.sha;
    } else if (getRes.status !== HTTP_NOT_FOUND) {
      console.warn('[capture] github read failed', { status: getRes.status });
      return;
    }

    const body: Record<string, unknown> = {
      message: `capture: ${capture.title || capture.url}`,
      content: encodeBase64(appendEntry(existing, capture)),
      branch: config.branch,
    };
    if (sha) body.sha = sha;

    const putRes = await fetchFn(contentsUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
    if (putRes.status < HTTP_REDIRECT_MIN) return;
    if (putRes.status !== HTTP_CONFLICT) {
      console.warn('[capture] github write failed', { status: putRes.status });
      return;
    }
  }
  console.warn('[capture] github append dropped after conflict', { id: capture.id });
}
