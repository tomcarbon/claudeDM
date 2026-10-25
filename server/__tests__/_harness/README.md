# Fallback test harness

`vitest` is the canonical runner for this project (`npm test` → `vitest run`, config in
`vitest.config.js`). **This directory is not a replacement for it.**

It exists because this checkout's `node_modules` was installed without dev dependencies —
`node_modules/vitest` is absent, `node_modules/.package-lock.json` contains no `"dev": true`
entries — so `npm test` exits 127 (`sh: 1: vitest: not found`) before it loads a single test
file. Running `npm install` was out of scope for the work order that added this, so the suite
was run on plain Node instead, unmodified, to get a real number.

```bash
# every test file, each in its own process
node server/__tests__/_harness/run-all.mjs

# one file
node server/__tests__/_harness/run-file.mjs server/__tests__/ws-turns.test.js
```

Requires only Node (tested on v24) and the project's runtime dependencies.

## How it works

- `vitest-shim.mjs` implements the slice of the vitest API these tests use: `describe`, `it`,
  `test`, `expect` (21 matchers plus `.not` and `expect.stringContaining`/`any`/`anything`),
  `beforeEach`/`afterEach`/`beforeAll`/`afterAll`, and `vi.fn`/`vi.spyOn`/`vi.restoreAllMocks`.
  It is strict: an unimplemented matcher throws instead of silently passing.
- `loader.mjs` is an ESM resolve hook that maps the bare specifier `vitest` to the shim, so the
  test files need no edits.
- `run-file.mjs` runs one file. The test files mix ESM `import` with CommonJS `require`; vitest
  supplies `require` in its module context, so the runner puts one on `globalThis` rooted at the
  test directory. It also installs the `no-live-agent` guard first and refuses to start if the
  guard did not take.
- `run-all.mjs` spawns one child process per file, mirroring vitest's per-file isolation, which
  matters because `ws-handler.js` keeps module-level `Map`s.

## Known differences from vitest

- No parallelism, no watch mode, no coverage, no snapshots, no `vi.mock`, no fake timers, no
  `expect().resolves/.rejects`. All of these throw rather than pass.
- `toEqual` implements jest's "ignore undefined-valued keys" rule but not its full asymmetric
  matcher set.
- Per-test timeout is 20s (`HARNESS_TIMEOUT_MS` to change); vitest's default is 5s.

Once dev dependencies are installed, run `npm test` and trust that number over this one. If the
two disagree, the harness is wrong.
