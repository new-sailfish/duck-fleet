/**
 * Explicit module resolution for a profile-installed plugin.
 *
 * The Loader imports a plugin's own entry through the packaged application's resolution context,
 * so a bare specifier written inside plugin code is not guaranteed to find a package the profile
 * installed — and packages that the application bundles (notably Typert's protocol package) exist
 * only inside `app.asar`, where no `createRequire` anchor can see them. Resolution therefore tries,
 * in order:
 *
 *   1. the Loader's own module importer, which is the resolver that already loads this profile's
 *      plugins, reached through `ctx.loader.internal.import(specifier, baseUrl, {})`;
 *   2. Node's `createRequire` from this file — the ordinary case, when resolution follows the
 *      profile's `node_modules` link into this package;
 *   3. `createRequire` anchored at the DSH home and profile directories, then at the running
 *      harness's own resources directory.
 *
 * A dependency none of them resolves yields `undefined`; the caller degrades instead of failing
 * the whole plugin.
 *
 * @module dsh-fleet/resolve
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Anchors tried after the Loader's own importer, as absolute directory paths. */
function anchors() {
  const list = [fileURLToPath(new URL('../', import.meta.url))];
  const profileDirectory = process.env.DSH_PROFILE_DIR;
  if (profileDirectory !== undefined && profileDirectory !== '') list.push(profileDirectory);
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  list.push(home);
  for (const name of ['profiles', 'profile']) {
    list.push(join(home, name, process.env.DSH_PROFILE ?? 'desktop'));
  }
  if (typeof process.resourcesPath === 'string') list.push(process.resourcesPath);
  const executable = process.execPath ?? '';
  const marker = `${sep}resources${sep}`;
  const at = executable.indexOf(marker);
  if (at !== -1) list.push(executable.slice(0, at + marker.length - 1));
  return [...new Set(list.filter((entry) => typeof entry === 'string' && entry !== ''))];
}

const cache = new Map();

/** The Host context whose Loader owns profile module resolution, when one was supplied. */
let loaderContext;

/**
 * Tell the resolver which context's Loader to ask first.
 *
 * @param ctx - the Host context, or an object exposing `loader`.
 */
export function useLoaderFrom(ctx) {
  loaderContext = ctx;
}

/**
 * Ask the Loader's own module importer for one specifier.
 *
 * The Loader exposes the same `import(specifier, baseUrl, options)` it uses for plugin entries:
 * the packaged application's loader reaches packages the application bundles, and a
 * profile-configured loader additionally resolves the profile's own `node_modules`. Both shapes are
 * attempted, because a plugin must work under either.
 *
 * @param specifier - the package specifier to resolve.
 * @returns the module namespace, or `undefined` when no Loader is reachable or it declines.
 */
async function importThroughLoader(specifier) {
  const loader = loaderContext?.loader;
  if (loader === undefined) return undefined;
  const baseUrl = typeof loader.baseDir === 'string' && loader.baseDir !== ''
    ? loader.baseDir
    : pathToFileURL(`${process.env.DSH_PROFILE_DIR ?? process.cwd()}\\`).href;
  const importers = [];
  if (typeof loader.import === 'function') importers.push(() => loader.import(specifier, baseUrl, {}));
  if (loader.internal !== undefined && typeof loader.internal.import === 'function') {
    importers.push(() => loader.internal.import(specifier, baseUrl, {}));
  }
  for (const attempt of importers) {
    try {
      const imported = await attempt();
      if (imported !== undefined && imported !== null) return imported;
    } catch {
      // Try the next entry point.
    }
  }
  return undefined;
}

/**
 * Import one package, preferring the Loader's resolver.
 *
 * @param specifier - the package specifier to import.
 * @returns the module namespace, or `undefined` when nothing can resolve it.
 */
export async function importModule(specifier) {
  if (cache.has(specifier)) return cache.get(specifier);
  const throughLoader = await importThroughLoader(specifier);
  if (throughLoader !== undefined) {
    cache.set(specifier, throughLoader);
    return throughLoader;
  }
  const attempt = (async () => {
    for (const anchor of anchors()) {
      try {
        const require = createRequire(join(anchor, 'noop.js'));
        return await import(pathToFileURL(require.resolve(specifier)).href);
      } catch {
        // Try the next anchor.
      }
    }
    return undefined;
  })();
  cache.set(specifier, attempt);
  return attempt;
}

/** The anchors considered after the Loader, for diagnostics. */
export function resolutionAnchors() {
  return anchors();
}
