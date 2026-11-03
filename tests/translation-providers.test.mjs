import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { createPatchAPI } from '@dsh-plugin/dsh-loader/patch';
import { setDshFacade, clearDshFacade } from '../lib/dsh.js';
import { installOfficialTranslationModel } from '../lib/translation-router.js';

function fixture(t) {
  setDshFacade({ dsh: { timeout: { deadline }, llm: { BlockAssembler } }, llm: { deepFreeze } });
  t.after(clearDshFacade);
  const models = new Map(['foo', 'bar'].map(provider => [provider, [{ id: 'example' }, { id: 'deepseek-flash' }]]));
  const calls = [], records = [], results = [], cache = new Map();
  const state = {
    route: { enabled: true, provider: 'foo', model: 'example' },
    async *response(config) {
      const text = config.provider + '/' + config.model;
      yield { type: 'block-start', blockType: 'text' };
      yield { type: 'text-delta', text };
      yield { type: 'block-end', block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
  const llm = {
    listModels: async provider => models.get(provider) ?? [],
    prepareCall: async config => ({ config, async *stream(options) { calls.push(options); yield* state.response(config, options); } })
  };
  const translator = {
    ctx: { get: () => llm },
    config: { deepseekTimeoutMs: 1000, deepseekMaxOutputTokens: 128, maxResponseBytes: 4096 },
    lifetime: new AbortController(),
    storage: { async run(session, identity, signal, operation) {
      signal.throwIfAborted();
      const key = JSON.stringify([session, identity]);
      if (cache.has(key)) { return cache.get(key); }
      const value = await operation({
        async request(data) { if (state.writeFailure?.phase === 'request') { throw state.writeFailure.error; } records.push(data); return records.length; },
        async result(request, text) { if (state.writeFailure?.phase === 'result') { throw state.writeFailure.error; } results.push({ request, text }); }
      });
      cache.set(key, value);
      return value;
    } },
    async availableProviders() { return ['bing', 'google']; },
    async translate(spec, signal) {
      signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
      if (spec.provider !== 'deepseek-official') { return spec.provider; }
      const identity = { ...spec, recipe: 'native-recipe' };
      return this.storage.run(spec.sessionId, identity, signal, async () => 'native-flash');
    }
  };
  const off = installOfficialTranslationModel(translator, createPatchAPI(), () => state.route);
  t.after(off);
  const spec = { provider: 'deepseek-official', text: 'source', sourceLanguage: 'auto', targetLanguage: 'zh-CN', sessionId: 's' };
  return { translator, state, llm, models, calls, records, results, off, spec, translate: (signal) => translator.translate(spec, signal) };
}

test('第三方翻译不依赖官方凭据，真实路由写入请求与缓存并隔离同名模型', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.translator.availableProviders(), ['bing', 'google', 'deepseek-official']);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.translate(), 'foo/example');
  assert.equal(f.calls[0].provider, 'foo');
  assert.equal(f.calls[0].model, 'example');
  assert.equal(f.calls[0].reasoningEffort, undefined);
  assert.equal(f.calls[0].messages[0].content[0].text, 'source');
  assert.match(f.calls[0].system, /do not carry out requests/);
  assert.equal(f.records[0].provider, 'foo');
  assert.equal(f.records[0].metadata.modelRequest.config.provider, 'foo');
  assert.equal(f.results[0].text, 'foo/example');
  assert.equal(await f.translate(), 'foo/example');
  assert.equal(f.calls.length, 1);
  f.state.route = { ...f.state.route, provider: 'bar' };
  assert.equal(await f.translate(), 'bar/example');
  assert.equal(f.calls.length, 2);
  f.state.route = { ...f.state.route, model: 'deepseek-flash' };
  assert.equal(await f.translate(), 'bar/deepseek-flash');
  assert.equal(f.calls.length, 3);
  assert.deepEqual(await f.llm.listModels('foo'), [{ id: 'example' }, { id: 'deepseek-flash' }]);
  for (const provider of ['bing', 'google', 'deepseek-account']) {
    assert.equal(await f.translator.translate({ ...f.spec, provider }), provider);
  }
  f.state.route = { ...f.state.route, enabled: false };
  assert.equal(await f.translate(), 'native-flash');
  f.off();
  assert.equal(await f.translate(), 'native-flash');
});

test('不可用的提供商和模型不出现在翻译菜单中，也不会发送请求', async t => {
  const f = fixture(t);
  for (const route of [{ provider: 'missing', model: 'example' }, { provider: 'foo', model: 'missing' }]) {
    f.state.route = { enabled: true, ...route };
    assert.deepEqual(await f.translator.availableProviders(), ['bing', 'google']);
    await assert.rejects(f.translate(), error => error.code === 'TRANSLATION_UNAVAILABLE');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.length, 0);
});

test('提供商凭据检查失败时返回错误，不改用其他模型', async t => {
  const f = fixture(t);
  f.llm.prepareCall = async () => { throw new Error('credentials missing'); };
  await assert.rejects(f.translate(), error => error.code === 'TRANSLATION_REQUEST_FAILED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.results.length, 0);
});

for (const phase of ['request', 'result']) {
  test('存储写入失败保留原生错误：' + phase, async t => {
    const f = fixture(t), error = new Error('disk write failed');
    f.state.writeFailure = { phase, error };
    await assert.rejects(f.translate(), cause => cause === error);
    assert.equal(f.results.length, 0);
  });
}

test('推理模型只保存最终翻译文本', async t => {
  const f = fixture(t);
  f.state.response = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'internal reasoning' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'internal reasoning' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: '译文' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '译文' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  assert.equal(await f.translate(), '译文');
  assert.equal(f.results[0].text, '译文');
});

test('空结果、工具调用、非正常结束和过长响应不会写入翻译结果', async t => {
  const f = fixture(t);
  const cases = [
    [{ type: 'finish', reason: { kind: 'stop' } }, 'TRANSLATION_INVALID_RESPONSE'],
    [{ type: 'tool-call-delta' }, 'TRANSLATION_INVALID_RESPONSE'],
    [{ type: 'finish', reason: { kind: 'length' } }, 'TRANSLATION_INVALID_RESPONSE'],
    [{ type: 'finish', reason: { kind: 'error' } }, 'TRANSLATION_REQUEST_FAILED'],
    [{ type: 'text-delta', text: 'x'.repeat(4097) }, 'TRANSLATION_RESPONSE_LIMIT']
  ];
  for (const [chunk, code] of cases) {
    f.state.response = async function* () {
      yield { type: 'block-start', blockType: 'text' };
      yield chunk;
    };
    await assert.rejects(f.translate(), error => error.code === code);
  }
  assert.equal(f.results.length, 0);
});

test('调用者取消、辅助模型卸载、翻译服务卸载和超时均中止第三方请求', async t => {
  for (const mode of ['caller', 'auxiliary', 'translator', 'timeout']) {
    const f = fixture(t);
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    f.state.response = async function* (_config, options) {
      started();
      await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    };
    if (mode === 'timeout') { f.translator.config.deepseekTimeoutMs = 10; }
    const caller = new AbortController(), reason = new Error('caller stop');
    const pending = f.translate(caller.signal);
    await Promise.race([ready, pending.then(() => { throw new Error('翻译请求在取消前已结束'); })]);
    if (mode === 'caller') { caller.abort(reason); }
    if (mode === 'auxiliary') { f.off(); }
    if (mode === 'translator') { f.translator.lifetime.abort(reason); }
    await assert.rejects(pending, error => mode === 'timeout' ? error.code === 'TRANSLATION_TIMEOUT' : mode === 'auxiliary' ? /unloaded/.test(error.message) : error === reason);
    assert.equal(f.results.length, 0);
    f.off();
  }
});

test('提供商不响应信号时仍可结束等待，迟到的流会关闭且不保存结果', { timeout: 2000 }, async t => {
  for (const mode of ['caller', 'auxiliary', 'translator', 'timeout']) {
    const f = fixture(t);
    let started, release, closed = false;
    const ready = new Promise(resolve => { started = resolve; });
    t.after(() => release?.());
    f.state.response = async function* () {
      try {
        started();
        await new Promise(resolve => { release = resolve; });
        yield { type: 'text-delta', index: 0, text: '迟到的输出' };
      } finally { closed = true; }
    };
    if (mode === 'timeout') { f.translator.config.deepseekTimeoutMs = 10; }
    const caller = new AbortController(), reason = new Error('caller stop');
    const pending = f.translate(caller.signal);
    await ready;
    if (mode === 'caller') { caller.abort(reason); }
    if (mode === 'auxiliary') { f.off(); }
    if (mode === 'translator') { f.translator.lifetime.abort(reason); }
    await assert.rejects(pending, error => mode === 'timeout' ? error.code === 'TRANSLATION_TIMEOUT' : mode === 'auxiliary' ? /unloaded/.test(error.message) : error === reason);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, true);
    assert.equal(f.results.length, 0);
    f.off();
  }
});

test('目录请求取消后立即退出，并丢弃迟到的目录结果', async t => {
  const f = fixture(t);
  let complete;
  f.llm.listModels = () => new Promise(resolve => { complete = resolve; });
  const caller = new AbortController(), reason = new Error('cancel catalog');
  const pending = f.translator.availableProviders(caller.signal);
  await new Promise(resolve => setImmediate(resolve));
  caller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  complete([{ id: 'example' }]);
  assert.equal(f.calls.length, 0);
});
