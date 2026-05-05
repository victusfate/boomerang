import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index';
import { parseFeed } from './parseFeed';

const ORIGIN_DEV = 'http://localhost:5173';

async function req(method: string, path: string, origin = ORIGIN_DEV): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { Origin: origin },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('boomerang-rss');
  });
});

describe('CORS', () => {
  it('OPTIONS preflight returns 204 (Vite dev :5173)', async () => {
    const res = await req('OPTIONS', '/bundle');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_DEV);
  });

  it('OPTIONS preflight allows GH Pages preview :4173', async () => {
    const origin = 'http://localhost:4173';
    const res = await req('OPTIONS', '/bundle', origin);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });
});

describe('bundle route', () => {
  it('GET /bundle?include=__none__ returns 400', async () => {
    const res = await req('GET', '/bundle?include=__none__');
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe('404', () => {
  it('unknown path returns 404', async () => {
    const res = await req('GET', '/unknown');
    expect(res.status).toBe(404);
  });
});

const TEST_SOURCE = {
  id: 'test', name: 'Test', feedUrl: 'http://example.com/feed',
  category: 'general' as const, enabled: true,
};

describe('parseFeed — entity decoding', () => {
  // Helpers to build minimal RSS/Atom XML
  function rssXml(title: string, description: string) {
    return `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Test</title>
      <item>
        <title>${title}</title>
        <link>https://example.com/1</link>
        <description>${description}</description>
        <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
  }

  function cdataRss(title: string, description: string) {
    return `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Test</title>
      <item>
        <title><![CDATA[${title}]]></title>
        <link>https://example.com/1</link>
        <description><![CDATA[${description}]]></description>
        <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
  }

  it('decodes typographic named entities in plain XML text nodes', async () => {
    const articles = await parseFeed(
      rssXml('News &mdash; Today&rsquo;s Update', 'Read more&hellip; it&rsquo;s here &amp; there'),
      TEST_SOURCE,
    );
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('News — Today’s Update');
    expect(articles[0].description).toContain('Read more…');
    expect(articles[0].description).toContain('it’s here & there');
  });

  it('decodes named entities in CDATA sections', async () => {
    const articles = await parseFeed(
      cdataRss(
        'Price &ndash; &pound;9.99 &copy; 2024',
        'High&nbsp;demand&hellip; &ldquo;breaking&rdquo; news &mdash; &euro;100',
      ),
      TEST_SOURCE,
    );
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Price – £9.99 © 2024');
    expect(articles[0].description).toContain('“breaking”');
    expect(articles[0].description).toContain('—');   // mdash
    expect(articles[0].description).toContain('€100'); // euro
  });

  it('decodes numeric decimal and hex character references', async () => {
    const articles = await parseFeed(
      cdataRss('Title &#8212; end', 'Desc &#x2019;quoted&#x2019; &#169;'),
      TEST_SOURCE,
    );
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Title — end');
    expect(articles[0].description).toContain('’quoted’');
    expect(articles[0].description).toContain('©');
  });

  it('leaves unknown entity references intact', async () => {
    const articles = await parseFeed(
      cdataRss('Hello &unknownentity; world', 'Some text'),
      TEST_SOURCE,
    );
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('Hello &unknownentity; world');
  });
});

