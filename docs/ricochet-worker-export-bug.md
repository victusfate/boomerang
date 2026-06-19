# Bug: `./worker` export missing transitive source files — v2.1.0

**Package:** `@victusfate/ricochet`  
**Version:** 2.1.0 (SHA `6846ccc5f0abfe9eea5df1c845f0feb7cc99ae37`)  
**Affected consumers:** any package that imports `@victusfate/ricochet/worker`

---

## Summary

The `./worker` export in `package.json` points to `./src/index.ts`, but most
of the files that `src/index.ts` and `src/RecDO.ts` import are absent from the
published package. TypeScript cannot resolve the transitive modules, so `tsc`
fails with 11 errors.

---

## `package.json` as published

```json
{
  "version": "2.1.0",
  "exports": {
    ".": {
      "types": "./dist/lib.d.ts",
      "import": "./dist/lib.js",
      "require": "./dist/lib.cjs"
    },
    "./worker": "./src/index.ts"
  },
  "files": [
    "dist",
    "docs/api",
    "src/lib.ts",
    "src/scoring.ts",
    "src/types.ts",
    "src/validation.ts",
    "src/index.ts",
    "src/RecDO.ts",
    "src/parsing.ts",
    "src/worker-env.ts"
  ]
}
```

---

## What's actually present in `src/` after install

```
src/
  RecDO.ts      ✓ (listed in files)
  index.ts      ✓ (listed in files)
  lib.ts        ✓
  parsing.ts    ✓
  scoring.ts    ✓
  types.ts      ✓
  validation.ts ✓
  worker-env.ts ✓
```

---

## What `src/index.ts` imports (first 20 lines)

```ts
import { RecDO } from './RecDO';
export { RecDO };
export type { RecWorkerEnv } from './worker-env';
import type { RecWorkerEnv } from './worker-env';
import { corsHeaders } from './cors';        // ✗ src/cors.ts not in files
import { json } from './http';               // ✗ src/http.ts not in files
import {
  getRecDOStub,
  handleArticles,
  handleInteractions,
  handleRecommendations,
} from './handlers';                         // ✗ src/handlers.ts not in files
export { isAllowedOrigin } from './cors';    // ✗
export { buildRecCacheKey } from './rec-cache'; // ✗ src/rec-cache.ts not in files
```

---

## Missing files (not in `files`, not present after install)

| File | Imported by |
|------|-------------|
| `src/cors.ts` | `src/index.ts` |
| `src/http.ts` | `src/index.ts` |
| `src/handlers.ts` | `src/index.ts` |
| `src/rec-cache.ts` | `src/index.ts` |
| `src/rec-config.ts` | `src/RecDO.ts` |
| `src/rec-db.ts` | `src/RecDO.ts` |
| `src/rec-learning.ts` | `src/RecDO.ts` |
| `src/rec-ranking.ts` | `src/RecDO.ts` |

---

## TypeScript errors produced (`tsc --noEmit`)

```
node_modules/@victusfate/ricochet/src/RecDO.ts(7,8): error TS2307:
  Cannot find module './rec-config' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/RecDO.ts(8,85): error TS2307:
  Cannot find module './rec-db' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/RecDO.ts(9,26): error TS2307:
  Cannot find module './rec-learning' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/RecDO.ts(12,8): error TS2307:
  Cannot find module './rec-ranking' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/RecDO.ts(151,33): error TS7006:
  Parameter 'r' implicitly has an 'any' type.

node_modules/@victusfate/ricochet/src/RecDO.ts(191,31): error TS7006:
  Parameter 'r' implicitly has an 'any' type.

node_modules/@victusfate/ricochet/src/index.ts(5,29): error TS2307:
  Cannot find module './cors' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/index.ts(6,22): error TS2307:
  Cannot find module './http' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/index.ts(12,8): error TS2307:
  Cannot find module './handlers' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/index.ts(15,33): error TS2307:
  Cannot find module './cors' or its corresponding type declarations.

node_modules/@victusfate/ricochet/src/index.ts(16,34): error TS2307:
  Cannot find module './rec-cache' or its corresponding type declarations.
```

---

## Suggested fix

**Option A — add missing source files to `files`:**

```json
"files": [
  "dist",
  "docs/api",
  "src"
]
```

Shipping the entire `src/` directory is the simplest fix and makes the
source-based `./worker` export self-consistent.

**Option B — compile worker to `dist` and point the export there:**

```json
"exports": {
  ".": {
    "types": "./dist/lib.d.ts",
    "import": "./dist/lib.js",
    "require": "./dist/lib.cjs"
  },
  "./worker": {
    "types": "./dist/worker.d.ts",
    "import": "./dist/worker.js"
  }
}
```

This matches the pattern used for the main `.` entry and avoids shipping raw
TypeScript to consumers who may not have a compatible `tsc` setup.

---

## Workaround (consumer side)

Pin to v1.10.0 until the `./worker` entry is fixed:

```json
"@victusfate/ricochet": "github:victusfate/ricochet#v1.10.0"
```
