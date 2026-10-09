/**
 * Reach a package that ships INSIDE the DeepSeek Harness application rather than in this checkout.
 *
 * Three suites assert against the harness's own implementations — the tool registry's JSON Schema subset
 * (`@deepseek-ai/dsh-tools`), the snapshot rules (`@deepseek-ai/dsh-util-values`) — precisely so the plugin is
 * checked against the real thing instead of a copy of its rules. Those packages live in the application's
 * `app.asar`, and they are NOT dependencies of this package: a plugin gets them as peers at runtime.
 *
 * The path therefore cannot be hard-coded. Doing so made the suites pass on the machine they were written on and
 * fail everywhere else — and after a scrub of machine-identifying strings, it made them fail HERE too, because
 * the rewritten path no longer existed. Deriving it from the running process is what keeps the suites honest:
 * they measure the harness that is actually executing them.
 *
 * @module duck-fleet/test/harness
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the running harness keeps its bundled packages, or `undefined` outside the application. */
export function harnessModulesPath() {
  const resources = process.resourcesPath;
  if (typeof resources !== 'string' || resources === '') return undefined;
  const candidate = join(resources, 'app.asar', 'dsh', 'node_modules');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Import one harness-bundled package.
 *
 * @param specifier - the package to import, e.g. `@deepseek-ai/dsh-tools`.
 * @returns the module namespace.
 * @throws when the harness cannot be located or does not carry the package — a test must say WHY it cannot
 *   measure, not silently measure nothing.
 */
export async function importFromHarness(specifier) {
  const modules = harnessModulesPath();
  if (modules === undefined) {
    throw new Error(
      `cannot locate the DeepSeek Harness application, so \`${specifier}\` is unreachable — run this suite with `
      + 'the harness\'s own runtime, or inside an installed application',
    );
  }
  const require = createRequire(join(modules, 'noop.js'));
  return await import(pathToFileURL(require.resolve(specifier)).href);
}
