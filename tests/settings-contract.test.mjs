/**
 * Regression tests for the DSH 0.2.0 settings contract.
 *
 * The reported production crash was:
 *
 *   TypeError: sctx.settings.register is not a function
 *     at installSettingsSectionFallback (…/dsh-loader/dist/services/settings.js:106)
 *     at Object.installSection (…/dsh-loader/dist/services/settings.js:300)
 *     at new apply (…/dsh-auxiliary/lib/index.js:192)
 *
 * DSH 0.2.0 moved settings into the profile plugin Config: `dsh-settings` dropped
 * both the `installSettingsSection` module export and the `SettingsForms.register`
 * method, while `@dsh-plugin/dsh-loader@1.3.5` still forwards to them. The plugin
 * must therefore never reach that path again, and its own entry must expose a
 * volatile form or the "Auxiliary Models" page silently disappears from Settings.
 *
 * These tests pin the three things that make the fix real:
 *   1. the exported `Config` validates into `Volatile<T>` leaves (the 0.2.0 shape
 *      `apply` actually receives) and a non-empty volatile form (without which
 *      `SettingsForms.describe()` omits the entry entirely);
 *   2. `apply` wires the settings service through the 0.2.0 contract
 *      (`settings.configure`) and never calls `register`/`installSection`;
 *   3. `apply` tolerates a settings service that exposes no `register` at all —
 *      the exact runtime that crashed before.
 *
 * @module dsh-auxiliary/tests/settings-contract
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { Config } from '../lib/config.js';
import { apply } from '../lib/index.js';

/**
 * Build the validated plugin config Cordis hands to `apply` on 0.2.0.
 *
 * This deliberately runs the REAL schema rather than hand-rolling references, so
 * the test proves the shipped schema produces the shape `apply` and
 * `resolvePluginConfig` are written against.
 *
 * @param raw - raw composition values (what a profile patch would carry).
 * @returns the validated config with `Volatile<T>` leaves.
 */
function liveConfig(raw = {}) {
  return Config(raw);
}

/**
 * A stub Cordis context recording what `apply` touches.
 *
 * `inject` runs its callback with a child scope whose `settings` exposes only
 * `configure` — deliberately NOT `register`/`installSection`, which is exactly
 * what 0.2.0-rc.2's `SettingsForms` looks like. A `register` decoy throws the
 * production error text if the plugin ever reaches for it.
 *
 * @returns the stub context plus the recorded calls.
 */
function harness() {
  const calls = { configure: [], registerCalls: [] };
  const settings = {
    configure(presentation, owner) {
      calls.configure.push({ presentation, owner });
      return () => {};
    },
    describe: () => [],
  };
  settings.register = (...args) => {
    calls.registerCalls.push(args);
    throw new TypeError('sctx.settings.register is not a function');
  };

  const ctx = {
    fiber: { uid: 'plugin-fiber' },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
      registerConfigurableProviders: () => ({ dispose() {} }),
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    effect: (fn) => {
      fn();
      return { dispose() {} };
    },
    inject: (deps, callback) => {
      if (!deps.includes('settings')) return;
      callback({ settings, effect: (fn) => fn() });
    },
    get: () => undefined,
    root: { on: () => () => {} },
    dshLoader: {
      dsh: {
        tools: { defineTool: (definition) => definition, ToolArgsError: class extends Error {} },
        timeout: { deadline: () => ({ signal: new AbortController().signal, [Symbol.dispose]() {} }) },
        credentials: { credentialRef: (ref) => ref },
        subagent: { delegationDepthOf: () => 0 },
        compaction: { BasicCompactionEngine: class {} },
        llm: { BlockAssembler: class {} },
      },
      llm: { createUserMessage: (input) => ({ ...input, id: 'm', role: 'user' }) },
    },
  };
  return { ctx, calls };
}

test('apply wires settings through the 0.2.0 contract and never calls register', () => {
  const { ctx, calls } = harness();
  apply(ctx, liveConfig());

  assert.equal(calls.configure.length, 1, 'settings.configure must be called exactly once');
  assert.deepEqual(
    calls.configure[0].presentation,
    { auto: false },
    'auto:false keeps the plugin-owned Auxiliary Models page instead of a generated one',
  );
  assert.strictEqual(
    calls.configure[0].owner,
    ctx.fiber,
    'the policy must be registered on the plugin’s own fiber so it unwinds with it',
  );
  assert.deepEqual(calls.registerCalls, [], 'the removed settings.register must never be called');
});

test('apply does not require a settings service that still has register/installSection', () => {
  const { ctx, calls } = harness();
  // The harness `settings` has `register` (a throwing decoy) but NO
  // `installSection`; the old code path probed for the latter and then fell back
  // to the former, which is precisely the production crash.
  assert.doesNotThrow(() => apply(ctx, liveConfig()));
  assert.deepEqual(calls.registerCalls, [], 'apply must not reach for register even when present');
});

test('apply accepts a settings service exposing neither register nor installSection', () => {
  const { ctx, calls } = harness();
  // Strip the throwing decoy entirely: this is 0.2.0-rc.2's real `SettingsForms`
  // surface (configure/describe/update/replace/mutate only). The plugin must
  // wire itself up without ever probing for the removed APIs.
  const child = {
    settings: { configure: () => () => {}, describe: () => [] },
    effect: (fn) => fn(),
  };
  ctx.inject = (deps, callback) => {
    if (deps.includes('settings')) callback(child);
  };
  assert.doesNotThrow(() => apply(ctx, liveConfig()));
  assert.deepEqual(calls.registerCalls, []);
});

test('apply re-reconciles on the loader volatile-update signal', () => {
  const { ctx } = harness();
  const listeners = new Map();
  ctx.on = (name, listener) => {
    listeners.set(name, listener);
    return () => {};
  };
  apply(ctx, liveConfig({ tool: { enabled: false } }));
  assert.ok(listeners.has('loader/volatile-update'), 'apply must subscribe to the refresh signal');
  // A volatile-only change mutates references in place, so the event is what
  // tells the plugin to re-read them; it must not throw.
  assert.doesNotThrow(() => listeners.get('loader/volatile-update')([['tool', 'enabled']]));
});

test('exported Config validates into volatile leaves, not plain values', () => {
  const config = liveConfig();

  // Grouping objects stay plain: schemastery rejects a volatile node nested
  // inside another volatile node.
  assert.equal(isVolatile(config.vision), false, 'grouping objects must stay plain');
  assert.equal(isVolatile(config.engine), false, 'grouping objects must stay plain');

  // Editable leaves arrive as Volatile<T> references.
  for (const [group, field] of [
    ['vision', 'provider'],
    ['vision', 'model'],
    ['tool', 'enabled'],
    ['engine', 'thresholdRatio'],
  ]) {
    assert.ok(
      isVolatile(config[group][field]),
      `${group}.${field} must be a Volatile<T> reference`,
    );
  }

  assert.equal(config.tool.enabled.get(), true, 'volatile leaf resolves to its value');
  assert.equal(config.engine.thresholdRatio.get(), 0.8, 'volatile leaf resolves to its value');
});

test('exported Config projects a non-empty volatile form', () => {
  // SettingsForms.describe() drops an entry whose volatileForm() is undefined,
  // and update() throws `Plugin entry "<ns>" has no volatile fields`. A schema
  // with no volatile leaf therefore makes the settings page vanish silently.
  const json = Config.toJSON();
  // schemastery's serialized envelope stores nested schemas in a `refs` table,
  // so the tree is walked through `refs` rather than inline `dict` values.
  const refs = json.refs ?? {};
  const volatileRefs = Object.values(refs).filter((node) => node?.meta?.volatile === true);

  assert.ok(volatileRefs.length > 0, 'the plugin entry must expose at least one volatile field');
  assert.ok(
    volatileRefs.some((node) => node.meta.description?.includes('inspect_image')),
    'vision.provider must be volatile (its description is unique)',
  );
  // No node may be both volatile and contain a volatile child: schemastery
  // throws "volatile fields require a fixed object path without an enclosing
  // volatile field". Grouping objects must therefore carry no volatile flag.
  const volatileObjectRefs = volatileRefs.filter((node) => node.type === 'object' || node.type === 'dict');
  assert.deepEqual(volatileObjectRefs, [], 'no grouping object may itself be volatile');
});