import assert from 'node:assert/strict';
import test from 'node:test';
import { registerImageHandoff } from '../lib/image-handoff.js';

const image = (id) => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
});

function request(model, content, signal, provider = 'mock') {
  return {
    provider,
    model,
    messages: [{ role: 'user', content, source: { kind: 'user' } }],
    ...(signal ? { signal } : {}),
  };
}

function harness({ modalities, adapter }) {
  let listener;
  const calls = [];
  const resolutions = [];
  const config = {
    tool: { enabled: true },
    vision: { handoff: true, provider: 'vision', model: 'aux' },
  };
  const llm = {
    async resolveModelInfo(provider, model, signal) {
      resolutions.push({ provider, model, signal });
      const value = typeof modalities === 'function'
        ? await modalities(model, provider)
        : (modalities[`${provider}/${model}`] ?? modalities[model]);
      return { provider, id: model, name: model, ...(value === undefined ? {} : { inputModalities: value }) };
    },
    stream(options) {
      return listener(options, () => {
        calls.push(options);
        return adapter(options);
      });
    },
  };
  const originalResolve = llm.resolveModelInfo;
  const ctx = {
    llm,
    on(name, callback) {
      assert.equal(name, 'llm/stream');
      listener = callback;
      return () => { listener = (_options, next) => next(); };
    },
  };
  const dispose = registerImageHandoff(ctx, () => config);
  return { ctx, calls, resolutions, dispose, originalResolve, config };
}

async function collect(iterable) {
  const result = [];
  for await (const chunk of iterable) result.push(chunk);
  return result;
}

const done = { type: 'finish', reason: { kind: 'stop' } };
const oneChunk = async function* () { yield done; };

test('native-capable route receives original image blocks', async () => {
  const h = harness({ modalities: { native: ['text', 'image'] }, adapter: oneChunk });
  const options = request('native', [{ type: 'text', text: 'inspect' }, image('native')]);
  assert.deepEqual(await collect(h.ctx.llm.stream(options)), [done]);
  assert.equal(h.calls.length, 1);
  assert.strictEqual(h.calls[0], options);
  assert.equal(h.calls[0].messages[0].content[1].type, 'image');
  const effective = await h.ctx.llm.resolveModelInfo('mock', 'native');
  assert.deepEqual(effective.inputModalities, ['text', 'image']);
});

test('admission shim exposes text-only main routes while routing uses real metadata', async () => {
  const h = harness({ modalities: { text: ['text'] }, adapter: oneChunk });
  const effective = await h.ctx.llm.resolveModelInfo('mock', 'text');
  assert.deepEqual(effective.inputModalities, ['text', 'image']);
  await collect(h.ctx.llm.stream(request('text', [image('fallback')])));
  assert.equal(h.calls[0].messages[0].content[0].type, 'text');
});

test('selected auxiliary route stays honest and bypasses fallback rewriting', async () => {
  const h = harness({ modalities: { 'vision/aux': ['text'] }, adapter: oneChunk });
  const effective = await h.ctx.llm.resolveModelInfo('vision', 'aux');
  assert.deepEqual(effective.inputModalities, ['text']);
  const options = request('aux', [image('aux')], undefined, 'vision');
  await collect(h.ctx.llm.stream(options));
  assert.strictEqual(h.calls[0], options);
  assert.equal(h.calls[0].messages[0].content[0].type, 'image');
});

test('disabled handoff restores admission and stream semantics', async () => {
  const h = harness({ modalities: { text: ['text'] }, adapter: oneChunk });
  h.config.tool.enabled = false;
  const disabled = await h.ctx.llm.resolveModelInfo('mock', 'text');
  assert.deepEqual(disabled.inputModalities, ['text']);
  const options = request('text', [image('disabled')]);
  await collect(h.ctx.llm.stream(options));
  assert.strictEqual(h.calls[0], options);
});

test('text-only route rewrites top-level and nested tool-result images immutably', async () => {
  const h = harness({ modalities: { text: ['text'] }, adapter: oneChunk });
  const options = request('text', [
    image('top'),
    { type: 'tool-result', toolCallId: 'call', content: [image('nested'), { type: 'text', text: 'kept' }] },
  ]);
  await collect(h.ctx.llm.stream(options));
  assert.notStrictEqual(h.calls[0], options);
  const content = h.calls[0].messages[0].content;
  assert.match(content[0].text, /^\[image: /);
  assert.equal(content[1].content[0].type, 'text');
  assert.match(content[1].content[0].text, /"attachmentId":"nested"/);
  assert.equal(content[1].content[1].text, 'kept');
  assert.equal(options.messages[0].content[0].type, 'image');
  assert.equal(Object.isFrozen(h.calls[0]), true);
});

test('unknown input modalities use the safe text fallback', async () => {
  const h = harness({ modalities: { unknown: undefined }, adapter: oneChunk });
  await collect(h.ctx.llm.stream(request('unknown', [image('unknown')])));
  assert.equal(h.calls[0].messages[0].content[0].type, 'text');
});

test('requests without images skip capability resolution', async () => {
  const h = harness({ modalities: { native: ['text', 'image'] }, adapter: oneChunk });
  const options = request('native', [{ type: 'text', text: 'hello' }]);
  await collect(h.ctx.llm.stream(options));
  assert.equal(h.resolutions.length, 0);
  assert.strictEqual(h.calls[0], options);
});

test('concurrent native and text requests keep request-local reentrancy', async () => {
  let releaseText;
  const textGate = new Promise((resolve) => { releaseText = resolve; });
  const h = harness({
    modalities: async (model) => {
      if (model === 'text') await textGate;
      return model === 'native' ? ['text', 'image'] : ['text'];
    },
    adapter: oneChunk,
  });
  const textRun = collect(h.ctx.llm.stream(request('text', [image('text')])));
  const nativeRun = collect(h.ctx.llm.stream(request('native', [image('native')])));
  await nativeRun;
  releaseText();
  await textRun;
  const byModel = Object.fromEntries(h.calls.map((call) => [call.model, call]));
  assert.equal(byModel.native.messages[0].content[0].type, 'image');
  assert.equal(byModel.text.messages[0].content[0].type, 'text');
  assert.equal(h.resolutions.length, 2);
});

test('signal and terminal abort/error chunks pass through unchanged', async () => {
  const controller = new AbortController();
  const aborted = { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stop' } } };
  const h = harness({ modalities: { text: ['text'] }, adapter: async function* (options) {
    assert.strictEqual(options.signal, controller.signal);
    yield aborted;
  } });
  const output = await collect(h.ctx.llm.stream(request('text', [image('abort')], controller.signal)));
  assert.strictEqual(output[0], aborted);
  assert.strictEqual(h.resolutions[0].signal, controller.signal);

  const failure = new Error('middleware failure');
  const throwing = harness({ modalities: { native: ['text', 'image'] }, adapter: async function* () { throw failure; } });
  await assert.rejects(collect(throwing.ctx.llm.stream(request('native', [image('error')]))), failure);
});

test('early consumer return closes the delegated iterator', async () => {
  let closed = false;
  const h = harness({ modalities: { text: ['text'] }, adapter: async function* () {
    try {
      yield { type: 'text-delta', text: 'first' };
      yield done;
    } finally {
      closed = true;
    }
  } });
  for await (const _chunk of h.ctx.llm.stream(request('text', [image('close')]))) break;
  assert.equal(closed, true);
});

test('dispose is idempotent and restores the original resolver identity', () => {
  const h = harness({ modalities: { text: ['text'] }, adapter: oneChunk });
  assert.notStrictEqual(h.ctx.llm.resolveModelInfo, h.originalResolve);
  h.dispose();
  h.dispose();
  assert.strictEqual(h.ctx.llm.resolveModelInfo, h.originalResolve);
});

test('dispose does not clobber a resolver installed later', async () => {
  const h = harness({ modalities: { text: ['text'] }, adapter: oneChunk });
  const handoffResolve = h.ctx.llm.resolveModelInfo;
  const laterResolve = async (...args) => handoffResolve(...args);
  h.ctx.llm.resolveModelInfo = laterResolve;
  h.dispose();
  assert.strictEqual(h.ctx.llm.resolveModelInfo, laterResolve);
  const info = await h.ctx.llm.resolveModelInfo('mock', 'text');
  assert.deepEqual(info.inputModalities, ['text'], 'retained wrapper becomes an inert pass-through');
});

test('a lazily-created stream passes through when disposed before iteration', async () => {
  const h = harness({ modalities: { text: ['text'] }, adapter: oneChunk });
  const options = request('text', [image('late-dispose')]);
  const stream = h.ctx.llm.stream(options);
  h.dispose();
  await collect(stream);
  assert.strictEqual(h.calls[0], options);
  assert.equal(h.calls[0].messages[0].content[0].type, 'image');
});

test('disposal during capability lookup prevents a late rewritten dispatch', async () => {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    modalities: async () => {
      markStarted();
      await gate;
      return ['text'];
    },
    adapter: oneChunk,
  });
  const options = request('text', [image('lookup-dispose')]);
  const run = collect(h.ctx.llm.stream(options));
  await started;
  h.dispose();
  release();
  await run;
  assert.strictEqual(h.calls[0], options);
  assert.equal(h.calls[0].messages[0].content[0].type, 'image');
});
