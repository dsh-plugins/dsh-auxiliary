import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { installProviderCompaction } from '../lib/provider-compaction.js';
import { compactionPayload, remoteCheckpoint } from '../lib/responses-compaction.js';

const text = (role, id, value, source = { kind: 'user' }) => ({
  role, id, source, content: [{ type: 'text', text: value }],
});
const ordinary = [
  text('system', 'system', 'instructions'),
  text('user', 'one', 'first question'),
  text('assistant', 'two', 'first answer'),
  text('user', 'three', 'latest question'),
];
const summaryInstruction = text('user', 'compact', 'DSH built-in instruction', { kind: 'plugin' });
const route = { provider: 'responses-provider', model: 'test-model' };
const encrypted = { type: 'compaction', id: 'cmp_mock', encrypted_content: 'encrypted-server-state' };

function harness(mode, protocol = 'openai-responses') {
  const events = [];
  const sent = [];
  const usage = { inputTokens: 2, cacheReadTokens: 50, outputTokens: 4, totalTokens: 56 };
  const models = {
    async *streamSimple(_model, options, hooks) {
      const payload = { input: options.messages.map(message => ({ role: message.role, content: message.content })) };
      const wire = await hooks?.onPayload?.(payload, _model) ?? payload;
      sent.push({ options, wire });
      if (wire.input.at(-1)?.type === 'compaction_trigger') {
        await hooks.onProviderStreamEvent({ type: 'response.output_item.done', item: encrypted }, _model);
        await hooks.onProviderStreamEvent({ type: 'response.completed', response: { status: 'completed', output: [encrypted] } }, _model);
        yield { type: 'usage', usage };
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no conversational content' } } };
        return;
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'text response' } };
      yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const adapter = { current: () => ({ models }) };
  let installed;
  function dispatch(options) {
    const end = () => models.streamSimple({ api: protocol }, options);
    return installed.route(options, end, end);
  }
  const llm = { registration: () => ({ adapter }), stream: dispatch };
  const session = {
    requestHeader: () => ({ config: { ...route, reasoningEffort: 'max' } }),
    requestContext: () => ({ contextWindow: 4096 }),
    deriveMessages: () => ordinary,
    snapshotEvents: () => events,
  };
  const config = { providers: { [route.provider]: { api: protocol, dshAuxiliaryCompaction: mode } } };
  const ctx = {
    llm,
    get: service => ({
      sessions: { get: () => session },
      settings: { describe: () => [{ ns: 'llm-pi-ai', user: config }] },
      tokenMeter: { measure: () => ({ totalTokens: 100 }) },
    })[service],
  };
  const patch = { method(target, key, wrap) {
    const original = target[key];
    target[key] = wrap(original);
    return { dispose() { target[key] = original; } };
  } };
  installed = installProviderCompaction(ctx, patch);
  const send = (messages, purpose) => Array.fromAsync(dispatch({ ...route, messages, sessionId: 'session', maxTokens: 512, purpose }));
  return { sent, events, usage, send, dispose: installed.dispose };
}

test('Kimi full-history summary inherits the conversation effort and appends a handoff instruction', async t => {
  const host = harness('kimi');
  t.after(host.dispose);
  await host.send([...ordinary.slice(0, 3), summaryInstruction], 'compaction');
  const request = host.sent[0].options;
  assert.equal(request.reasoningEffort, 'max');
  assert.deepEqual(request.messages.slice(0, -1), ordinary);
  assert.match(request.messages.at(-1).content[0].text, /same language/);
});

test('stock compaction and other protocols keep their original request', async t => {
  for (const host of [harness('dsh'), harness('remote-v2', 'openai-completions'), harness(undefined)]) {
    t.after(host.dispose);
    await host.send([...ordinary, summaryInstruction], 'compaction');
    assert.equal(host.sent[0].options.messages.at(-1), summaryInstruction);
  }
});

test('remote V2 appends a native trigger, stores the opaque output and replays it on the next request', async t => {
  const host = harness('remote-v2');
  t.after(host.dispose);
  const chunks = await host.send([...ordinary, summaryInstruction], 'compaction');
  const first = host.sent[0];
  assert.deepEqual(first.wire.input.at(-1), { type: 'compaction_trigger' });
  assert.equal(first.wire.input.length, ordinary.length + 1);
  assert.equal(first.options.reasoningEffort, 'max');
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, host.usage);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  const rawOutput = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  const marker = remoteCheckpoint.markerIn(rawOutput[0].text);
  assert.deepEqual(remoteCheckpoint.decode(rawOutput[1].text), { ...route, marker, item: encrypted });
  host.events.push({ type: 'compaction/summary', data: { ...route, rawOutput } });

  const checkpoint = text('user', 'checkpoint',
    'This is an automatically generated checkpoint. ' + rawOutput[0].text, { kind: 'compact-checkpoint' });
  await host.send([ordinary[0], checkpoint, ordinary[3]]);
  assert.deepEqual(host.sent[1].wire.input[1], encrypted);
  assert.deepEqual(host.sent[1].wire.input[2].content, ordinary[3].content);

  // Text typed by a user cannot instruct the adapter to replay an opaque checkpoint.
  await host.send([ordinary[0], { ...checkpoint, source: { kind: 'user' } }]);
  assert.equal(host.sent[2].wire.input[1].role, 'user');
});

test('V2 refuses to send a synthetic prompt when its trigger is absent from the SDK payload', () => {
  assert.throws(() => compactionPayload({ input: [] }, {
    ...route, replays: new Map(), trigger: { ...route, marker: '[not in request]' },
  }), /did not pass the compaction instruction/);
});

test('ordinary chat can use the optional session store from a Cordis fiber without a sessions injection', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  let lookups = 0;
  class Llm extends Service {
    constructor(ctx) { super(ctx, 'llm'); }
  }
  class Sessions extends Service {
    constructor(ctx) { super(ctx, 'sessions'); }
    get(id) {
      assert.equal(id, 'session');
      lookups += 1;
      return { requestHeader: () => ({ config: route }) };
    }
  }
  await root.plugin(Llm);
  const sessions = root.plugin(Sessions);
  await sessions;
  let router;
  await root.plugin({
    inject: ['llm'],
    apply(ctx) {
      assert.throws(() => ctx.sessions, /without inject/);
      router = installProviderCompaction(ctx, {});
    },
  });
  async function* generate() { yield { type: 'finish', reason: { kind: 'stop' } }; }
  const options = { ...route, messages: ordinary, sessionId: 'session' };
  const result = await Array.fromAsync(router.route(options, generate, generate));
  assert.deepEqual(result, [{ type: 'finish', reason: { kind: 'stop' } }]);
  assert.equal(lookups, 1);
  await sessions.dispose();
  assert.deepEqual(await Array.fromAsync(router.route(options, generate, generate)), result);
  assert.equal(lookups, 1);
});
