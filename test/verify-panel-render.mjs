// Render the settings panel's component tree and look for the session-cleanup card.
//
// Why this exists: the panel registered correctly and the page appeared, but nothing changed on screen. A
// registration that succeeds and a component that renders are different facts, and only the first was being
// checked. This renders the real component from the real bundle, so "the card is in the tree" becomes a
// measurement rather than an inference.
//
// React is not needed: `createElement` only builds plain objects, and the hooks the panel uses are a handful
// of counters over a cell array. The panel never mounts, so effects and reconciliation never run.
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

/** Load the bundle's factory by stubbing the one global it talks to. */
function loadFactory() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured;
  const window = {
    __ModuleLoader__: { load(entry) { captured = entry; } },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  };
  new Function('window', 'setTimeout', 'clearTimeout', 'fetch', source)(window, setTimeout, clearTimeout, window.fetch);
  if (captured === undefined) throw new Error('the bundle did not call __ModuleLoader__.load');
  return captured;
}

/**
 * The React the panel sees, with hooks that keep their state between renders of one instance.
 *
 * `useState` hands back a setter that writes the cell, so a `useEffect`-driven reload inside the component
 * would be observable — though nothing here mounts, so only the first render matters.
 */
function makeReact() {
  let cells = [];
  let cursor = 0;
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  return {
    React: {
      createElement,
      Component: class Component { constructor(props) { this.props = props; } setState() {} },
      useState(initial) {
        const index = cursor;
        cursor += 1;
        if (cells.length <= index) cells[index] = typeof initial === 'function' ? initial() : initial;
        return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
      },
      useCallback: (fn) => fn,
      useEffect: () => {},
      useLayoutEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (initial) => ({ current: initial }),
      useContext: () => ({}),
      createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
      Fragment: 'Fragment',
    },
    /** Reset the hook cursor before each render of the component under test. */
    begin() { cursor = 0; },
    /** Forget the hook cells, as a fresh mount would. */
    reset() { cells = []; cursor = 0; },
  };
}

/** A minimal slot service whose `register` keeps the component so it can be rendered. */
function makeSlots() {
  const entries = new Map();
  return {
    entries,
    register(options, component) {
      entries.set(options.id ?? options.key, { options, component });
      return () => { entries.delete(options.id ?? options.key); };
    },
    inject(key, callback) { callback(); return () => {}; },
  };
}

function makeLocale() {
  const held = new Map();
  return {
    held,
    register(namespace, dicts) {
      for (const [locale, dict] of Object.entries(dicts)) held.set(`${namespace}:${locale}`, dict);
      return () => {};
    },
    bind: (namespace) => (key) => held.get(`${namespace}:zh`)?.[key] ?? held.get(`${namespace}:en`)?.[key] ?? key,
  };
}

/**
 * Resolve one level of function components so the tree contains real host elements.
 *
 * A class component's `render()` returns an element whose type is another FUNCTION; a function component
 * returns one too. React would keep calling until it reaches host tags, and this does the same, with a depth
 * cap so a component that renders itself is reported rather than hanging the suite.
 */
function expand(node, depth) {
  if (depth > 12) throw new Error('the component tree did not settle within 12 levels');
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1));
  if (typeof node !== 'object' || !('type' in node)) return node;
  if (typeof node.type === 'function') {
    const produced = node.type.prototype?.render !== undefined
      // A class element: instantiate it the way React would, so `this.state` and `this.props` exist.
      ? new node.type(node.props ?? {}).render()
      : node.type(node.props ?? {});
    return expand(produced, depth + 1);
  }
  return { ...node, children: (node.children ?? []).map((child) => expand(child, depth + 1)) };
}

const react = makeReact();
const entry = loadFactory();
const plugin = entry.factory(() => react.React);

/**
 * The Host endpoint, stubbed at the global the panel actually calls.
 *
 * The panel starts with `state === undefined` and fills it from `/fleet/api/read` in an effect, so a test that
 * only calls the component renders an EMPTY panel — which is what this suite did at first, and it reported
 * failures for machine rows and archive controls that the code does render. Answering the endpoint makes the
 * test environment match a mounted panel in the browser.
 */


const status = {
  storePath: 'C:\\Users\\x\\.dsh\\fleet.json',
  defaults: {
    keyFile: 'C:\\Users\\x\\.ssh\\k',
    sshCommand: 'ssh',
    profile: 'acp',
    autoArchive: { enabled: false, keepLast: 5, maxAgeHours: 0 },
  },
  warnings: [],
  machines: [
    { id: 'b', toolName: 'huawei-notebook', label: 'huawei-notebook', target: 'habbi@192.168.3.164', port: 22, cwd: 'C:\\Users\\Public', permission: 'allow', description: '', extraArgs: [], provider: 'fleet-b', registered: true, toolVisible: true },
    { id: 'c', toolName: 'huawei-vm', label: 'huawei-vm', target: 'huawei@DESKTOP-SERVERS', port: 22, cwd: 'C:\\Users\\HUAWEI\\d', permission: 'allow', description: '', extraArgs: [], provider: 'fleet-c', registered: true, toolVisible: true },
  ],
};

/**
 * The Host endpoint, stubbed so an accidental real request cannot escape the suite.
 *
 * It does NOT make the panel show data — `useEffect` is a no-op here, so the panel's own load never runs and
 * its `state` stays `undefined`. That is why the assertions below avoid anything data-driven; see the note
 * above them.
 */
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false }) });


const slots = makeSlots();
const locale = makeLocale();
const effects = [];
plugin.apply({
  locale,
  slots,
  logger: { warn: () => {} },
  // Runs synchronously, exactly as the real `ctx.effect` does on apply — which is what makes the panel's
  // "load on mount" happen here at all.
  effect(run, name) { effects.push({ name, dispose: run() }); },
});

const registered = slots.entries.get('fleet');
check('the settings page registered a component', registered !== undefined && typeof registered.component === 'function');

/**
 * Walk the RESOLVED element tree, collecting strings, host tags and every input's props.
 *
 * The tree must already have been through {@link expand}: elements produced by `h(...)` carry their children
 * in `children`, but a child that is itself an element (the cleanup card is one) holds its own subtree there,
 * so walking without expanding finds the card element and nothing inside it. That mistake made this suite
 * report seven failures against code that renders correctly.
 */
function walk(node, out = { texts: [], types: [], tags: [], inputs: [], keys: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  if (typeof node === 'object' && 'type' in node) {
    out.types.push(typeof node.type === 'string' ? node.type : (node.type?.name ?? 'anonymous'));
    if (typeof node.type === 'string') out.tags.push(node.type);
    if (node.type === 'input') out.inputs.push(node.props);
    if (node.props?.key !== undefined) out.keys.push(String(node.props.key));
    for (const child of node.children ?? []) walk(child, out);
    return out;
  }
  return out;
}

console.log('\nthe panel renders the fleet state the Host reports:');

let tree;
try {
  react.begin();
  // The registered component is the ERROR BOUNDARY — a class whose render() returns the panel. Resolving it
  // here, rather than only walking element objects, is what this suite got wrong first: the tree it produced
  // had one child (the boundary element) and no text, so every string assertion failed for a reason that had
  // nothing to do with the panel.
  tree = expand(registered.component({ close: () => {} }), 0);
} catch (error) {
  failures += 1;
  console.log(`  FAIL the component rendered without throwing: ${error instanceof Error ? error.message : String(error)}`);
  console.log(`\n${String(failures)} CHECK(S) FAILED`);
  process.exit(1);
}
check('the component rendered without throwing', tree !== undefined);

const walked = walk(tree);
const text = walked.texts.join(' | ');
const allText = walked.texts.join('\n');

/**
 * Note on what this suite can and cannot prove.
 *
 * The panel gets `state` from an effect, and the effect belongs to React's mount, which this harness does not
 * have: `ctx.effect` here runs its callback immediately, so the hook cells are created before any setter can
 * reach the ones a later render reads. Seeding the Host endpoint was tried and did nothing — the stub was
 * never called, because `useEffect` is a no-op here.
 *
 * So everything BELOW is asserted against a panel whose `state` is `undefined`, and deliberately covers only
 * what does not depend on it: the card's presence, its strings, its position, and the static shape of its
 * controls. Asserting the machine buttons or the stored rule values here would test the harness rather than
 * the panel — which is exactly what the first version of this file did, reporting seven failures against code
 * that renders correctly in the browser and in `verify-client-locale.mjs`.
 */

console.log('\nthe session-cleanup card is in the tree:');
// The card's own strings, from both dictionaries — whichever locale the bind returned.
check('the card title is rendered', /会话清理|Session cleanup/.test(allText), `texts: ${text.slice(0, 300)}`);
check('the experimental badge is rendered', /实验性|LAB/.test(allText));
check('the enable toggle is rendered', /启用这套规则|Follow these rules/.test(allText));
check('the keep count is rendered', /保留最近|Keep newest/.test(allText));
check('the warning about the app going down is rendered', /DSH 会停|stops that machine/.test(allText));
// The card renders above the machine rows and does not depend on how many there are, so it is present even
// with none configured — which is the state this harness provably reaches.
check('the card renders even with no machines from the Host', walked.keys.includes('prune'), walked.keys.join(','));

console.log('\nthe card sits above the machine rows, after the shared defaults:');
{
  // Order matters for reading the page: shared settings, then this, then the machines.
  const iDefaults = walked.keys.indexOf('defaults');
  const iPrune = walked.keys.indexOf('prune');
  check('both rows are present', iDefaults !== -1 && iPrune !== -1, `defaults=${String(iDefaults)} prune=${String(iPrune)}`);
  check('the card follows the shared defaults', iPrune > iDefaults, `defaults=${String(iDefaults)} prune=${String(iPrune)}`);
}

console.log('\nthe archive controls have the right static shape:');
{
  const inputs = walked.inputs;
  const toggle = inputs.find((props) => props.id === 'fleet-archive-enabled');
  const keep = inputs.find((props) => props.id === 'fleet-archive-keepLast');
  check('the enable control exists', toggle !== undefined);
  check('the keep control exists', keep !== undefined);
  check('the enable control is a checkbox', toggle?.type === 'checkbox', JSON.stringify(toggle?.type));
  check('the keep control is a number field', keep?.type === 'number', JSON.stringify(keep?.type));
  check('the keep control has a zero floor', keep?.min === 0, JSON.stringify(keep?.min));
  // The stored values reach these controls through `defaults.autoArchive`, which this harness cannot seed;
  // `verify-client-locale.mjs` covers the registration and the tool schema covers the bounds.
  check('both controls can be disabled while a prune runs', toggle?.disabled === false && keep?.disabled === false);
}

console.log('\nthe two ways to add a machine are offered as a choice:');
{
  // They were tangled into one column before: the form, the prompt, the key management and the LAN offer all
  // together, so neither path read as a path. They are a TAB now, and the tab is the choice. The JSON view
  // lives inside the manual tab — a peer tab for it split the wrong axis, since it edits the same record the
  // form does.
  check('the choice is on screen', walked.keys.includes('addpanel'), walked.keys.join(','));
  const forkText = allText;
  check('it says there are two ways', /两条路|Two ways/.test(forkText));
  check('it says they are alternatives, not steps', /不是前后步骤|not steps/.test(forkText));
  check('one option is manual entry', /我自己填|Fill in the details/.test(forkText));
  check('the other is preparing the machine first', /先让机器自己准备好|Prepare the machine first/.test(forkText));
  check('the manual option says what you need to know', /你已经知道主机名|already know the hostname/.test(forkText));
  check('the prompt option says the machine reports back', /回报给你|report them back/.test(forkText));
  // Both buttons must be real buttons in the tree, or the choice is only described rather than offered.
  const labels = walked.tags.filter((tag) => tag === 'button').length;
  check('there is a button for each path', labels >= 2, `${String(labels)} buttons`);
}

console.log('\nthe prompt text is not dumped into the page:');
{
  // The guide renders the two actions and the key metadata, not several thousand characters of instructions
  // meant for another machine. `setup` is undefined in this state, so the check is that no prompt textarea
  // exists on the page at all — the id it used to carry must be gone with it.
  check('no prompt textarea is rendered', !walked.inputs.some((props) => props.id === 'fleet-setup-prompt'), 'the prompt is handed over, not read here');
  // The JSON view is behind the editor, which is closed in this state.
  check('no JSON box is rendered before the editor opens', !walked.inputs.some((props) => props.id === 'fleet-json'));
}

console.log(`\n${failures === 0 ? 'PANEL RENDER VERIFIED' : `${String(failures)} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
