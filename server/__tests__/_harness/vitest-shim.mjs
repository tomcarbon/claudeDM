/**
 * A minimal stand-in for the parts of the `vitest` API this project's tests use.
 *
 * Why: `vitest` is a devDependency and this checkout's node_modules was installed without dev
 * dependencies, so `npm test` cannot start (see _harness/README.md). This shim plus
 * `run-file.mjs` runs the same test files, unmodified, on Node alone. Vitest remains the
 * canonical runner — this exists so the suite's result is a number rather than a blocker.
 *
 * It is deliberately strict: an unknown matcher throws rather than silently passing, because a
 * harness that invents passes is worse than no harness.
 */

// ---------------------------------------------------------------- registry

const rootSuite = { name: '', children: [], tests: [], beforeEach: [], afterEach: [], parent: null };
let currentSuite = rootSuite;
let hasOnly = false;

export function describe(name, fn) {
  const suite = { name, children: [], tests: [], beforeEach: [], afterEach: [], parent: currentSuite, skip: false };
  currentSuite.children.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  try { fn(); } finally { currentSuite = prev; }
  return suite;
}
describe.skip = (name, fn) => { const s = describe(name, fn); s.skip = true; return s; };
describe.only = (name, fn) => { const s = describe(name, fn); s.only = true; hasOnly = true; return s; };

export function it(name, fn, timeout) {
  currentSuite.tests.push({ name, fn, timeout, skip: !fn, only: false, suite: currentSuite });
}
it.skip = (name, fn) => { currentSuite.tests.push({ name, fn, skip: true, suite: currentSuite }); };
it.only = (name, fn, timeout) => {
  hasOnly = true;
  currentSuite.tests.push({ name, fn, timeout, skip: false, only: true, suite: currentSuite });
};
it.todo = (name) => { currentSuite.tests.push({ name, fn: null, skip: true, suite: currentSuite }); };
export const test = it;

export function beforeEach(fn) { currentSuite.beforeEach.push(fn); }
export function afterEach(fn) { currentSuite.afterEach.push(fn); }
export function beforeAll(fn) { currentSuite.beforeAll = (currentSuite.beforeAll || []).concat(fn); }
export function afterAll(fn) { currentSuite.afterAll = (currentSuite.afterAll || []).concat(fn); }

export function _getRoot() { return rootSuite; }
export function _hasOnly() { return hasOnly; }

// ---------------------------------------------------------------- equality

const ASYMMETRIC = Symbol.for('claudedm.harness.asymmetric');

function isAsymmetric(v) { return !!(v && typeof v === 'object' && v[ASYMMETRIC]); }

function deepEqual(a, b) {
  if (isAsymmetric(b)) return b.match(a);
  if (isAsymmetric(a)) return a.match(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  // jest/vitest `toEqual` ignores keys whose value is undefined on either side
  const ka = Object.keys(a).filter(k => a[k] !== undefined);
  const kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => kb.includes(k) && deepEqual(a[k], b[k]));
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 400 ? v.slice(0, 400) + '…' : v);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : (s.length > 400 ? s.slice(0, 400) + '…' : s);
  } catch { return String(v); }
}

class AssertionError extends Error {
  constructor(message) { super(message); this.name = 'AssertionError'; this.isAssertion = true; }
}

// ---------------------------------------------------------------- expect

function makeMatchers(actual, negated) {
  const ok = (pass, msg) => {
    if (pass === !negated) return;
    throw new AssertionError(negated ? `expected NOT: ${msg}` : `expected: ${msg}`);
  };
  const callAndCatch = () => {
    if (typeof actual !== 'function') throw new AssertionError('toThrow() requires a function');
    try { actual(); return null; } catch (e) { return e || new Error('thrown falsy value'); }
  };

  const m = {
    toBe(expected) { ok(Object.is(actual, expected), `${fmt(actual)} to be ${fmt(expected)}`); },
    toEqual(expected) { ok(deepEqual(actual, expected), `${fmt(actual)} to equal ${fmt(expected)}`); },
    toStrictEqual(expected) { ok(deepEqual(actual, expected), `${fmt(actual)} to strictly equal ${fmt(expected)}`); },
    toBeNull() { ok(actual === null, `${fmt(actual)} to be null`); },
    toBeUndefined() { ok(actual === undefined, `${fmt(actual)} to be undefined`); },
    toBeDefined() { ok(actual !== undefined, `${fmt(actual)} to be defined`); },
    toBeTruthy() { ok(!!actual, `${fmt(actual)} to be truthy`); },
    toBeFalsy() { ok(!actual, `${fmt(actual)} to be falsy`); },
    toBeNaN() { ok(Number.isNaN(actual), `${fmt(actual)} to be NaN`); },
    toBeInstanceOf(cls) { ok(actual instanceof cls, `${fmt(actual)} to be instance of ${cls && cls.name}`); },
    toBeGreaterThan(n) { ok(actual > n, `${fmt(actual)} > ${fmt(n)}`); },
    toBeGreaterThanOrEqual(n) { ok(actual >= n, `${fmt(actual)} >= ${fmt(n)}`); },
    toBeLessThan(n) { ok(actual < n, `${fmt(actual)} < ${fmt(n)}`); },
    toBeLessThanOrEqual(n) { ok(actual <= n, `${fmt(actual)} <= ${fmt(n)}`); },
    toBeCloseTo(n, digits = 2) { ok(Math.abs(actual - n) < Math.pow(10, -digits) / 2, `${fmt(actual)} close to ${fmt(n)}`); },
    toHaveLength(n) {
      ok(actual != null && actual.length === n, `${fmt(actual)} to have length ${n} (got ${actual == null ? 'null' : actual.length})`);
    },
    toContain(needle) {
      let pass;
      if (typeof actual === 'string') pass = actual.includes(needle);
      else if (Array.isArray(actual) || (actual && typeof actual.includes === 'function')) pass = actual.includes(needle);
      else if (actual && typeof actual.has === 'function') pass = actual.has(needle);
      else throw new AssertionError(`toContain() on unsupported value ${fmt(actual)}`);
      ok(pass, `${fmt(actual)} to contain ${fmt(needle)}`);
    },
    toContainEqual(needle) {
      ok(Array.isArray(actual) && actual.some(v => deepEqual(v, needle)), `${fmt(actual)} to contain equal ${fmt(needle)}`);
    },
    toMatch(re) {
      const pass = typeof re === 'string' ? String(actual).includes(re) : re.test(String(actual));
      ok(pass, `${fmt(actual)} to match ${re}`);
    },
    toMatchObject(expected) {
      const sub = {};
      for (const k of Object.keys(expected)) sub[k] = actual == null ? undefined : actual[k];
      ok(deepEqual(sub, expected), `${fmt(actual)} to match object ${fmt(expected)}`);
    },
    toHaveProperty(pathStr, value) {
      const parts = String(pathStr).split('.');
      let cur = actual;
      let found = true;
      for (const p of parts) {
        if (cur == null || !(p in Object(cur))) { found = false; break; }
        cur = cur[p];
      }
      const pass = arguments.length > 1 ? (found && deepEqual(cur, value)) : found;
      ok(pass, `${fmt(actual)} to have property ${pathStr}`);
    },
    toThrow(expected) {
      const err = callAndCatch();
      let pass = err !== null;
      if (pass && expected !== undefined) {
        const msg = String(err && err.message);
        pass = expected instanceof RegExp ? expected.test(msg)
          : typeof expected === 'string' ? msg.includes(expected)
            : msg.includes(String(expected && expected.message));
      }
      ok(pass, `function to throw ${expected === undefined ? '' : fmt(expected)} (got ${err ? fmt(err) : 'no throw'})`);
    },
    toHaveBeenCalled() {
      ok(!!(actual && actual.mock) && actual.mock.calls.length > 0, 'mock to have been called');
    },
    toHaveBeenCalledTimes(n) {
      ok(!!(actual && actual.mock) && actual.mock.calls.length === n, `mock to have been called ${n} times`);
    },
    toHaveBeenCalledWith(...args) {
      if (!actual || !actual.mock) throw new AssertionError('toHaveBeenCalledWith() requires a mock');
      const pass = actual.mock.calls.some(call => call.length === args.length && args.every((a, i) => deepEqual(call[i], a)));
      ok(pass, `mock to have been called with ${fmt(args)} (calls: ${fmt(actual.mock.calls)})`);
    },
  };
  m.toThrowError = m.toThrow;
  return m;
}

export function expect(actual) {
  const base = makeMatchers(actual, false);
  const proxied = new Proxy(base, {
    get(target, prop) {
      if (prop === 'not') return makeMatchers(actual, true);
      if (prop === 'resolves' || prop === 'rejects') {
        throw new AssertionError(`expect().${String(prop)} is not implemented in the fallback harness — run under vitest`);
      }
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('to')) {
        throw new AssertionError(`matcher "${prop}" is not implemented in the fallback harness — run under vitest`);
      }
      return target[prop];
    },
  });
  return proxied;
}

expect.stringContaining = (s) => ({ [ASYMMETRIC]: true, match: (v) => typeof v === 'string' && v.includes(s), toString: () => `stringContaining(${s})` });
expect.stringMatching = (re) => ({ [ASYMMETRIC]: true, match: (v) => (re instanceof RegExp ? re.test(String(v)) : String(v).includes(re)) });
expect.any = (cls) => ({
  [ASYMMETRIC]: true,
  match: (v) => (cls === String ? typeof v === 'string'
    : cls === Number ? typeof v === 'number'
      : cls === Boolean ? typeof v === 'boolean'
        : cls === Object ? typeof v === 'object' && v !== null
          : v instanceof cls),
});
expect.anything = () => ({ [ASYMMETRIC]: true, match: (v) => v !== null && v !== undefined });

// ---------------------------------------------------------------- vi

const spies = [];

function makeMockFn(impl) {
  const state = { calls: [], results: [] };
  const fn = function (...args) {
    state.calls.push(args);
    if (fn._impl) return fn._impl.apply(this, args);
    return undefined;
  };
  fn._impl = impl || null;
  fn.mock = state;
  fn.mockImplementation = (f) => { fn._impl = f; return fn; };
  fn.mockReturnValue = (v) => { fn._impl = () => v; return fn; };
  fn.mockResolvedValue = (v) => { fn._impl = () => Promise.resolve(v); return fn; };
  fn.mockClear = () => { state.calls.length = 0; return fn; };
  fn.mockReset = () => { state.calls.length = 0; fn._impl = null; return fn; };
  return fn;
}

export const vi = {
  fn: (impl) => makeMockFn(impl),
  spyOn(obj, prop) {
    const original = obj[prop];
    const spy = makeMockFn(typeof original === 'function' ? original.bind(obj) : undefined);
    spy.mockRestore = () => { obj[prop] = original; };
    obj[prop] = spy;
    spies.push(spy);
    return spy;
  },
  restoreAllMocks() {
    while (spies.length) { const s = spies.pop(); if (s.mockRestore) s.mockRestore(); }
  },
  clearAllMocks() { for (const s of spies) s.mockClear(); },
  mock() {
    throw new Error('vi.mock() is not supported by the fallback harness — run this file under vitest');
  },
  useFakeTimers() { throw new Error('vi.useFakeTimers() is not supported by the fallback harness'); },
};

export default { describe, it, test, expect, beforeEach, afterEach, beforeAll, afterAll, vi };
