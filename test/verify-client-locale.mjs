// The client panel's locale registration, exercised through the real bundle.
//
// `lib/client.js` is a plain browser bundle: it calls `window.__ModuleLoader__.load({ id, factory })` and
// takes React from the platform module table. Stubbing that one global is enough to obtain the factory and
// run its `apply`, which is where the panel lives — no browser and no DSH composition needed.
//
// The failure this exists for, reported from a live session:
//
//     dsh-duck-fleet: Error: locale namespace "fleet" already has locale "en"
//
// The locale service allows one occupant per (namespace, locale) and throws on a second registration, so a
// re-application that did not release the first one took the entire panel down.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/**
 * The React the panel sees.
 *
 * A stub rather than the real thing: in the browser this comes from the platform's module table, and React is
 * not among the packages the application ships under its `node_modules`. Nothing here renders — `apply` only
 * builds elements, it never mounts them — so a `createElement` that records its arguments is the whole
 * surface this suite exercises.
 */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  // The panel wraps itself in an error boundary, and a boundary is a class component.
  Component: class Component { constructor(props) { this.props = props; } },
};

/** Load the bundle's factory by stubbing the one global it talks to. */
function loadFactory() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured;
  const window = {
    __ModuleLoader__: {
      load(entry) { captured = entry; },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  // The bundle is a script, not a module: evaluating it with `new Function` keeps its `window` reference
  // bound to the stub above instead of the real one.
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'setTimeout', 'clearTimeout', source)(window, () => React, setTimeout, clearTimeout);
  if (captured === undefined) throw new Error('the bundle did not call __ModuleLoader__.load');
  return captured;
}

/**
 * A locale service with the real contract for this case: `register` returns a disposer and THROWS if the
 * namespace already holds that locale.
 */
function makeLocale() {
  const held = new Map();
  return {
    held,
    register(namespace, dicts) {
      for (const locale of Object.keys(dicts)) {
        if (held.has(`${namespace}:${locale}`)) {
          throw new Error(`locale namespace "${namespace}" already has locale "${locale}"`);
        }
      }
      for (const [locale, dict] of Object.entries(dicts)) held.set(`${namespace}:${locale}`, dict);
      return () => {
        for (const locale of Object.keys(dicts)) held.delete(`${namespace}:${locale}`);
      };
    },
    bind: () => (key) => key,
  };
}

function makeContext(locale) {
  const effects = [];
  return {
    effects,
    locale,
    slots: { inject: () => {}, register: () => {} },
    logger: { warn: () => {} },
    effect(run, name) { effects.push({ name, dispose: run() }); },
  };
}

console.log('\nthe bundle loads and exposes the panel plugin:');
const entry = loadFactory();
check('the entry id matches the package', entry.id === 'dsh-duck-fleet', entry.id);
check('the factory is callable', typeof entry.factory === 'function');
const plugin = entry.factory(() => React);
check('the plugin declares its inject surface', plugin.inject.includes('slots') && plugin.inject.includes('locale'), JSON.stringify(plugin.inject));
check('the plugin has an apply', typeof plugin.apply === 'function');

console.log('\nit registers both dictionaries:');
{
  const locale = makeLocale();
  const ctx = makeContext(locale);
  plugin.apply(ctx);
  check('en is registered', locale.held.has('fleet:en'));
  check('zh is registered', locale.held.has('fleet:zh'));
  const en = locale.held.get('fleet:en');
  const zh = locale.held.get('fleet:zh');
  check('the two dictionaries have the same keys', JSON.stringify(Object.keys(en).sort()) === JSON.stringify(Object.keys(zh).sort()));
}

console.log('\napplying it twice does not throw (the reported failure):');
{
  // This is the exact sequence that failed: the panel is applied again while the first registration is
  // still live. The dispose below is what a `ctx.effect` teardown would NOT have done across factory
  // instances, so the plugin must do it itself.
  const locale = makeLocale();
  const first = makeContext(locale);
  plugin.apply(first);
  const second = makeContext(locale);
  let threw;
  try {
    plugin.apply(second);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('the second apply does not throw', threw === undefined, threw);
  check('and the namespace is still populated', locale.held.has('fleet:en') && locale.held.has('fleet:zh'));
}

console.log('\nthe teardown releases what it registered:');
{
  const locale = makeLocale();
  const ctx = makeContext(locale);
  plugin.apply(ctx);
  check('registered before teardown', locale.held.has('fleet:en'));
  for (const effect of ctx.effects) effect.dispose?.();
  check('released after teardown', !locale.held.has('fleet:en') && !locale.held.has('fleet:zh'));
  // A released namespace must be re-registerable, or a reload would leave the panel untranslated forever.
  let reThrew;
  try {
    plugin.apply(makeContext(locale));
  } catch (error) {
    reThrew = error instanceof Error ? error.message : String(error);
  }
  check('and re-registers cleanly afterwards', reThrew === undefined && locale.held.has('fleet:en'), reThrew);
}

console.log('\nan unrelated locale failure still surfaces:');
{
  // Only the "already has locale" collision is tolerated. A malformed tag, for instance, must not be
  // swallowed, or the panel would render with missing strings and say nothing.
  const locale = makeLocale();
  locale.register = () => { throw new Error('locale tag is malformed'); };
  const ctx = makeContext(locale);
  let surfaced;
  try {
    plugin.apply(ctx);
  } catch (error) {
    surfaced = error instanceof Error ? error.message : String(error);
  }
  check('a malformed-tag error is rethrown', surfaced === 'locale tag is malformed', surfaced);
}

console.log(`\n${failures === 0 ? 'CLIENT LOCALE REGISTRATION VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
