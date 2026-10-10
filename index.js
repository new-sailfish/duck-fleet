/**
 * `dsh-duck-fleet` (DuckFleet / 鸭群) — add a machine once, get its delegation tool automatically.
 *
 * ## What this entry point adds over `lib/plugin.js`
 *
 * `lib/plugin.js` is the implementation. This module materializes a **per-generation copy** of it and imports
 * from there, so an edited checkout can be picked up without restarting the host. That matters only when the
 * package is imported from a **symlinked source directory** (a `link:` dependency, which is how a development
 * checkout is mounted): the Loader caches a module by resolved path, so the symlink target is the path it
 * already holds, and editing the file cannot change what a running process sees.
 *
 * A published install behaves differently: `dsh plugin add dsh-duck-fleet` installs a real tree under the
 * profile's `node_modules`, and a fresh path is what the copy mechanism produces. It costs one directory of
 * copies and one extra `import`, and it degrades to the source path when it cannot write — losing only the
 * ability to pick up an edit without a re-enable, never the plugin.
 *
 * ## How an edited plugin is applied
 *
 * **Disable and re-enable this plugin's row** (Settings → Plugins). That is the supported path, and it
 * is the one the Loader is designed for: the row is re-activated and the plugin is imported afresh.
 *
 * A hot-reload through this module's own `apply` was also attempted and is deliberately NOT provided.
 * The Loader caches modules by resolved path and does not honor a `?query` suffix, so a second
 * activation can end up executing code from the first import: the freshly built copy is on disk,
 * the new tool registrations happen, and yet the handlers still close over the previous module's
 * constants. That failure is silent — everything looks reloaded while the old behavior persists — so
 * offering it would be worse than not having it. Passing a generation token through an explicit
 * `reload()` entry point does not help either, because that entry point is itself part of the cached
 * module.
 *
 * ## Read the version instead of guessing
 *
 * {@link FLEET_REVISION} is stamped into the `fleet_version` tool and into this package's own
 * diagnostics. After re-enabling the row, call `fleet_version`: the revision it reports is read from
 * the copy that is running — not from this module, whose constant a cached entry module would have
 * frozen at the first import — and the two digests it prints answer whether that copy was built from
 * the sources now on disk. No inference required.
 *
 * ## `inject` must stay static
 *
 * Cordis reads `inject` as a plain array while it prepares dependency injection, so a module whose
 * metadata depends on an awaited import would let the Loader read `inject` as `undefined` and
 * activate the plugin before its dependencies exist — which is exactly how a `webServer` route ends up
 * registered against nothing.
 *
 * @module dsh-duck-fleet
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The revision of this implementation.
 *
 * Bump the suffix whenever the plugin's behavior changes. It is what `fleet_version` reports, so a
 * reload can be confirmed by reading rather than by trusting.
 */
export const FLEET_REVISION = 'r4-version-probe';

const here = dirname(fileURLToPath(import.meta.url));

/** Where per-generation copies live, inside this package. */
const GENERATED_DIR = '.gen';

/**
 * Every implementation source that identifies a generation.
 *
 * `lib` is SCANNED rather than listed: a hand-maintained list silently omits a newly added module,
 * and the resulting copy would then be missing a file the implementation imports.
 *
 * @returns absolute paths, sorted so the token is stable.
 */
function sourceFiles() {
  const files = [join(here, 'index.js')];
  try {
    for (const entry of readdirSync(join(here, 'lib'))) {
      if (entry.endsWith('.js')) files.push(join(here, 'lib', entry));
    }
  } catch {
    // No lib directory: index.js alone still identifies the generation.
  }
  return files.sort();
}

/**
 * A token that changes whenever any implementation source changes.
 *
 * Modification time AND size are combined, in the style of a build stamp. That is cheap but NOT
 * collision-free — a rewrite that preserves timestamps and total length produces the same token — so
 * the token is only a DIRECTORY NAME. Freshness is decided by the content digest recorded inside the
 * copy, never by the token alone.
 *
 * @param files - the sources to fingerprint.
 * @returns the generation token, usable as a directory name.
 */
function tokenFor(files) {
  let newest = 0;
  let total = 0;
  for (const file of files) {
    try {
      const info = statSync(file);
      newest = Math.max(newest, info.mtimeMs, info.ctimeMs);
      total += info.size;
    } catch {
      // A file that vanished between listing and stat contributes nothing.
    }
  }
  return `g${String(Math.round(newest))}s${String(total)}`;
}

/** Why the last copy could not be built, when that happened; surfaced by the version tool. */
let buildProblem;

/** The token of the copy this process last loaded. */
let loadedToken = '(none yet)';

/**
 * The revision declared by the copy this process last loaded.
 *
 * Read from the copy's own entry module rather than from {@link FLEET_REVISION}: the Loader caches a
 * module by resolved path, so re-enabling the row runs THIS instance again and its constant still holds
 * the value from the first import. Reporting that value would name the previous revision while the new
 * copy runs — the exact misreading this diagnostic exists to prevent.
 */
let loadedRevision = FLEET_REVISION;

/**
 * The revision a directory declares, read from its entry module.
 *
 * @param directory - a generation copy, or the package root for the no-copy fallback.
 * @returns the declared revision, or this module's own when it cannot be read.
 */
function revisionOf(directory) {
  try {
    const source = readFileSync(join(directory, 'index.js'), 'utf8');
    return /FLEET_REVISION\s*=\s*'([^']+)'/.exec(source)?.[1] ?? FLEET_REVISION;
  } catch {
    return FLEET_REVISION;
  }
}

/**
 * The content digest of the current sources.
 *
 * This is what decides whether an existing copy may be reused. A token from timestamps and sizes can
 * collide — a rewrite that keeps mtimes and total length does exactly that — and reusing a copy whose
 * contents no longer match the sources produces a module that fails at import time with a *missing
 * export*, which is how this was found.
 *
 * @param files - the sources to digest.
 * @returns the hex digest.
 */
function digestOf(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.slice(here.length + 1));
    try {
      hash.update(readFileSync(file));
    } catch {
      hash.update('(unreadable)');
    }
  }
  return hash.digest('hex').slice(0, 32);
}

/** The line that lets a copy prove which sources it was built from. */
function sentinel(digest) {
  return `// dsh-duck-fleet-digest: ${digest}`;
}

/**
 * Materialize the current generation and return the path to import.
 *
 * A copy is reused only when its own recorded digest matches the sources. Anything else — no copy, an
 * unreadable sentinel, a digest mismatch — rebuilds it, so a stale directory can never be served.
 *
 * @returns `{ token, entry }` — the token and the absolute path of that generation's entry module.
 */
function buildGeneration() {
  const files = sourceFiles();
  const token = tokenFor(files);
  const digest = digestOf(files);
  const directory = join(here, GENERATED_DIR, token);
  const entry = join(directory, 'plugin.js');
  loadedToken = token;
  try {
    if (readFileSync(entry, 'utf8').includes(sentinel(digest))) {
      // A reused copy is still the copy this process runs, so it records its digest too. Leaving this to
      // the rebuild branch below made the reported digest describe an earlier build.
      loadedDigest = digest;
      loadedRevision = revisionOf(directory);
      return { token, entry };
    }
  } catch {
    // Not built yet, or unreadable: rebuild below.
  }
  try {
    mkdirSync(directory, { recursive: true });
    for (const file of files) {
      const relative = file.slice(here.length + 1);
      const destination = join(directory, relative);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(file, destination);
    }
    // The entry re-exports the copy's OWN implementation. It must NOT point back at
    // `../../lib/plugin.js`: that is the original path, which the Loader already has cached, so the
    // proxy would hand back the pre-edit module — every fresh copy would look correct on disk while
    // the process kept running the old code. Only the relative specifier below stays inside the copy.
    writeFileSync(entry, [
      `// Generated by DuckFleet: generation ${token}.`,
      sentinel(digest),
      '// The path is the cache key, and the digest above proves this copy matches the sources.',
      "export { apply, inject, name, setVersionProbe } from './lib/plugin.js';",
      '',
    ].join('\n'), 'utf8');
    loadedDigest = digest;
    loadedRevision = revisionOf(directory);
    return { token, entry };
  } catch (error) {
    buildProblem = String(error?.message ?? error);
    // The source implementation runs instead, so the revision is the one on disk — never this module's
    // constant, which a cached entry module has frozen at the first import.
    loadedRevision = revisionOf(here);
    return { token, entry: join(here, 'lib', 'plugin.js') };
  }
}

/** The digest recorded by the copy this process last loaded; `undefined` until one is loaded. */
let loadedDigest;

/**
 * What this process is running, for the `fleet_version` tool.
 *
 * The digest is the freshness signal: a copy records the digest of the sources it was built from, and
 * `sourcesDigest` is computed from those sources right now. Equal means the running copy is the current
 * code. A revision comparison alone cannot answer that, because a revision is a name and two different
 * sources can carry the same one.
 *
 * @returns the revision, the loaded generation, both digests, and any copy failure.
 */
export function fleetVersion() {
  const sourcesDigest = digestOf(sourceFiles());
  return {
    revision: loadedRevision,
    generation: loadedToken,
    digest: loadedDigest,
    sourcesDigest,
    inSync: loadedDigest === undefined ? undefined : loadedDigest === sourcesDigest,
    generated: buildProblem === undefined,
    ...buildProblem === undefined ? {} : { problem: buildProblem },
  };
}

/** Service names this plugin must have before it activates; see the module note. */
export const inject = ['subagents', 'tools', 'webServer'];

/** Loader metadata: the plugin's own name, distinct from the package name. */
export const name = 'fleet';

/**
 * Host plugin body: delegates to this generation's implementation module.
 *
 * Re-enabling the plugin row calls this again, which is what applies an edited implementation.
 */
export async function apply(ctx, config) {
  const { entry } = buildGeneration();
  const loaded = await import(new URL(`file:///${entry.replace(/\\/g, '/')}`).href);
  loaded.setVersionProbe(fleetVersion);
  return loaded.apply(ctx, { ...config });
}
