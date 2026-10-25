// ESM resolve hook for the fallback runner. Two jobs:
//
//   1. Map the bare specifier `vitest` to the local shim, so the project's test files can run
//      unmodified when the vitest devDependency is not installed.
//   2. The ESM half of the no-live-agent guard (WO-0035): redirect every specifier that would
//      reach the Claude Agent SDK to `helpers/sdk-esm-guard.mjs`, whose `query` throws.
//      `helpers/no-live-agent.js` patches `Module._load` and therefore covers `require()` only;
//      a dynamic `import()` of the SDK from an ESM test file would otherwise receive the genuine
//      `query`. The rule set lives in `helpers/no-live-agent-esm.mjs`, not here.
//
// Job 2 happens in two places in the function below, and the second one matters:
//   - by SPECIFIER, before resolution, which is what catches the bare package name and the
//     canary (a specifier that resolves to nothing on disk);
//   - by RESOLVED URL, after `nextResolve`, which catches a route to the package's entry points
//     that the specifier patterns did not predict. `nextResolve` resolves without loading, so
//     this inspection never loads the SDK.
// `vitest.config.js` has only the first of those two; it matches specifiers, not resolved ids.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  ESM_GUARD_MODULE,
  matchesGuardedEsmSpecifier,
  matchesGuardedEsmUrl,
} from '../helpers/no-live-agent-esm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM = pathToFileURL(path.join(here, 'vitest-shim.mjs')).href;
const SDK_ESM_GUARD = pathToFileURL(ESM_GUARD_MODULE).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest' || specifier === 'vitest/config') {
    return { url: SHIM, shortCircuit: true, format: 'module' };
  }
  if (matchesGuardedEsmSpecifier(specifier)) {
    return { url: SDK_ESM_GUARD, shortCircuit: true, format: 'module' };
  }
  const resolved = await nextResolve(specifier, context);
  if (resolved && matchesGuardedEsmUrl(resolved.url)) {
    return { ...resolved, url: SDK_ESM_GUARD, format: 'module' };
  }
  return resolved;
}
