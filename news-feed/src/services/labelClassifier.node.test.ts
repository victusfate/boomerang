import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPromptApiAvailable,
  classifyArticle,
  runClassificationPass,
  runTaggingPass,
  tagArticle,
} from './labelClassifier.ts';
import type { Article, UserLabel, LabelHit } from '../types.ts';

const EN_TEXT_IO = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

function mockArticle(id: string): Article {
  return {
    id,
    title: 'Test article title',
    url: 'https://example.com',
    description: 'A test description about AI.',
    publishedAt: new Date(),
    source: 'Test',
    sourceId: 'test',
    topics: ['technology'],
  };
}

function mockLabel(name: string): UserLabel {
  return { id: `lbl-${name}`, name, color: '#888888' };
}

test('isPromptApiAvailable returns false when LanguageModel not in globalThis', () => {
  assert.equal(isPromptApiAvailable(), false);
});

test('classifyArticle returns true when session responds YES', async () => {
  const session = { prompt: async (_: string) => 'YES' };
  const result = await classifyArticle(mockArticle('a1'), mockLabel('AI'), session);
  assert.equal(result, true);
});

test('classifyArticle returns false when session responds NO', async () => {
  const session = { prompt: async (_: string) => 'NO' };
  const result = await classifyArticle(mockArticle('a2'), mockLabel('AI'), session);
  assert.equal(result, false);
});

test('classifyArticle is case-insensitive (yes → true)', async () => {
  const session = { prompt: async (_: string) => 'yes' };
  const result = await classifyArticle(mockArticle('a3'), mockLabel('AI'), session);
  assert.equal(result, true);
});

test('runClassificationPass skips article already in existingHits', async () => {
  let createCalls = 0;
  (globalThis as any).LanguageModel = {
    create: async () => { createCalls++; return { prompt: async () => 'YES' }; },
  };
  const article = mockArticle('art-exists');
  const label = mockLabel('AI');
  const hit: LabelHit = { articleId: article.id, labelId: label.id, classifiedAt: 0 };
  const result = await runClassificationPass([article], label, [hit]);
  assert.equal(result.length, 0);
  assert.equal(createCalls, 0); // session never created
  delete (globalThis as any).LanguageModel;
});

test('runClassificationPass returns new hits for unclassified articles', async () => {
  (globalThis as any).LanguageModel = {
    create: async () => ({ prompt: async () => 'YES' }),
  };
  const article = mockArticle('art-new');
  const label = mockLabel('AI');
  const result = await runClassificationPass([article], label, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].articleId, article.id);
  assert.equal(result[0].labelId, label.id);
  delete (globalThis as any).LanguageModel;
});

test('runClassificationPass returns empty when LanguageModel unavailable', async () => {
  const result = await runClassificationPass([mockArticle('a4')], mockLabel('AI'), []);
  assert.equal(result.length, 0);
});

test('tagArticle parses comma-separated lowercase tags from session response', async () => {
  const session = { prompt: async (_: string) => 'Climate, Policy, COP29' };
  const tags = await tagArticle(mockArticle('t1'), [], session);
  assert.deepEqual(tags, ['climate', 'policy', 'cop29']);
});

test('runTaggingPass passes English expectedInputs/expectedOutputs to LanguageModel.create', async () => {
  let createArgs: unknown;
  (globalThis as any).LanguageModel = {
    availability: async (opts: unknown) => {
      if (opts && typeof opts === 'object' && 'expectedInputs' in opts) {
        assert.deepEqual(opts, EN_TEXT_IO);
      }
      return 'available';
    },
    create: async (opts: unknown) => {
      createArgs = opts;
      return { prompt: async () => 'alpha, beta' };
    },
  };
  const article = mockArticle('new-id');
  await runTaggingPass([article], [], () => {});
  assert.ok(createArgs && typeof createArgs === 'object');
  const o = createArgs as Record<string, unknown>;
  assert.deepEqual(o.expectedInputs, EN_TEXT_IO.expectedInputs);
  assert.deepEqual(o.expectedOutputs, EN_TEXT_IO.expectedOutputs);
  assert.match(String(o.systemPrompt), /tagger/i);
  delete (globalThis as any).LanguageModel;
});

test('runTaggingPass skips create when LanguageModel availability is unavailable', async () => {
  let createCalls = 0;
  let unavailableStatus: string | null = null;
  (globalThis as any).LanguageModel = {
    availability: async (opts: unknown) => {
      if (opts && typeof opts === 'object' && 'expectedInputs' in opts) {
        assert.deepEqual(opts, EN_TEXT_IO);
      }
      return 'unavailable';
    },
    create: async () => { createCalls++; return { prompt: async () => 'alpha, beta' }; },
  };
  await runTaggingPass([mockArticle('blocked')], [], () => {}, {
    onUnavailable: status => { unavailableStatus = status; },
  });
  assert.equal(createCalls, 0);
  assert.equal(unavailableStatus, 'unavailable');
  delete (globalThis as any).LanguageModel;
});

test('runTaggingPass treats downloadable as model-loading state, not unavailable', async () => {
  let createCalls = 0;
  const statuses: string[] = [];
  let unavailableCalls = 0;
  (globalThis as any).LanguageModel = {
    availability: async () => 'downloadable',
    create: async () => { createCalls++; return { prompt: async () => 'alpha, beta' }; },
  };
  await runTaggingPass([mockArticle('needs-download')], [], () => {}, {
    onModelStatus: status => { statuses.push(status); },
    onUnavailable: () => { unavailableCalls++; },
  });
  assert.equal(createCalls, 0);
  assert.deepEqual(statuses, ['checking', 'downloadable']);
  assert.equal(unavailableCalls, 0);
  delete (globalThis as any).LanguageModel;
});

test('runTaggingPass calls create for downloadable model during active user gesture', async () => {
  let createCalls = 0;
  const statuses: string[] = [];
  const originalNavigator = (globalThis as any).navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Test', languages: ['en-US'], userActivation: { isActive: true, hasBeenActive: true } },
  });
  (globalThis as any).LanguageModel = {
    availability: async () => 'downloadable',
    create: async () => { createCalls++; return { prompt: async () => 'alpha, beta' }; },
  };
  await runTaggingPass([mockArticle('needs-download-click')], [], () => {}, {
    onModelStatus: status => { statuses.push(status); },
  });
  assert.equal(createCalls, 1);
  assert.deepEqual(statuses.slice(0, 3), ['checking', 'downloadable', 'starting-download']);
  delete (globalThis as any).LanguageModel;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalNavigator,
  });
});

test('runTaggingPass invokes onTagged once per untagged article', async () => {
  const tagged: string[] = [];
  (globalThis as any).LanguageModel = {
    availability: async () => 'available',
    create: async () => ({ prompt: async () => 'one, two' }),
  };
  await runTaggingPass([mockArticle('x'), mockArticle('y')], [], (t) => {
    tagged.push(t.articleId);
  });
  assert.deepEqual(tagged.sort(), ['x', 'y'].sort());
  delete (globalThis as any).LanguageModel;
});
