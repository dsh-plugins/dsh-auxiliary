/** 校验已发布翻译服务的路由、会话缓存和生命周期，不调用外部模型。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpath, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPatchAPI } from '@dsh-plugin/dsh-loader/patch';
import { installOfficialTranslationModel } from '../lib/translation-router.js';
import { isOfficialAutoReviewCall } from '../lib/approve-router.js';
import { setDshFacade, clearDshFacade } from '../lib/dsh.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv.find(arg => arg.startsWith('--version='))?.slice(10);
const fixtures = process.argv.find(arg => arg.startsWith('--fixtures='))?.slice(11);
const versions = selected ? [selected] : ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2'];

for (const version of versions) {
  const installation = await realpath(fixtures ? resolve(fixtures, version) : resolve(root, '../dsh-network-settings/.cache/versions', version, 'node_modules/@deepseek-ai/dsh'));
  const upstream = createRequire(join(installation, 'package.json'));
  const translatorPackage = fixtures ? upstream : createRequire(upstream.resolve('@deepseek-ai/dsh-experimental-cot-translation-bundle/package.json'));
  const load = name => import(pathToFileURL(translatorPackage.resolve(name)).href);
  const [{ Context }, { default: Translator }, { default: SessionStore }, timeout, nativeLlm, values] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-experimental-translator'), load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-timeout'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-util-values'),
  ]);
  if (!fixtures) {
    const source = await readFile(upstream.resolve('@deepseek-ai/dsh-experimental-auto-review'), 'utf8');
    const policy = /const REVIEW_POLICY = \x60([\s\S]*?)\x60;/u.exec(source)?.[1];
    assert(policy);
    assert(isOfficialAutoReviewCall({ system: policy, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: 'ENVIRONMENT\n{}' }] }] }));
  }

  setDshFacade({ dsh: { timeout, llm: nativeLlm }, llm: values });
  const ctx = new Context(), sessions = new SessionStore(ctx), session = sessions.create('s');
  const calls = [], modelConfig = {}, ref = 'TEST_API_KEY';
  const catalogs = new Map([
    ['deepseek-official', [{ id: 'deepseek-flash' }, { id: 'deepseek-custom' }, { id: 'deepseek-other' }]],
    ['foo', [{ id: 'example' }, { id: 'deepseek-flash' }]], ['bar', [{ id: 'example' }]],
  ]);
  let configured = true, customConfigured = true, reasoning = false, failedWrite;
  ctx.on('session/flush', () => {
    if (session.snapshotEvents().at(-1)?.type === 'plugin:translator/' + failedWrite) { throw new Error('disk write failed'); }
  });
  const llm = {
    listProviders: () => [...catalogs.keys()].map(id => ({ id })),
    listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 'official-test', settingsPath: [] }],
    listModels: async provider => catalogs.get(provider) ?? [],
    prepareCall: async (config, signal) => {
      if (config.provider !== 'deepseek-official' && !customConfigured) { throw new Error('第三方凭据未配置'); }
      return { config, stream: async function* (options) {
        signal.throwIfAborted(); calls.push(options);
        let index = 0;
        if (reasoning) {
          yield { type: 'block-start', index, blockType: 'reasoning' };
          yield { type: 'reasoning-delta', index, text: 'internal reasoning' };
          yield { type: 'block-end', index, block: { type: 'reasoning', text: 'internal reasoning' } };
          index++;
        }
        const text = 'translated ' + config.provider + '/' + config.model;
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text };
        yield { type: 'block-end', index, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  };
  const entry = { options: { id: 'official-test', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }, fiber: { state: 2, config: { models: { get: () => modelConfig }, apiKeyEnv: { get: () => ref } } } };
  entry.fiber.effectiveConfig = entry.fiber.config;
  const persistence = {
    identity: {},
    stat: async () => ({ header: session.header }),
    open: async () => ({
      async read(start = 0, count) { return { events: session.snapshotEvents(start, count === undefined ? undefined : start + count) }; },
      async [Symbol.asyncDispose]() {},
    }),
  };
  for (const [key, value] of Object.entries({ llm, loader: { entries: () => [entry] }, credentials: { describe: async () => ({ configured }) }, sessionPersistence: persistence })) {
    ctx.provide(key, value);
  }
  let translator;
  const fiber = await ctx.plugin({
    inject: ['llm', 'loader', 'credentials', 'sessions', 'sessionPersistence'],
    apply(scope) { translator = new Translator(scope, Translator.Config({})); },
  });
  const records = () => session.snapshotEvents().filter(event => event.type === 'plugin:translator/request').map(event => event.data);
  let config = { enabled: true, provider: 'deepseek-official', model: 'deepseek-custom' };
  const off = installOfficialTranslationModel(translator, createPatchAPI(), () => config);
  try {
    assert((await translator.availableProviders()).includes('deepseek-official'));
    const spec = translator.resolve({ provider: 'deepseek-official', text: 'source fragment', targetLanguage: 'zh-CN', sessionId: 's' });
    assert.equal(await translator.translate(spec), 'translated deepseek-official/deepseek-custom');
    assert.equal(calls[0].reasoningEffort, 'off');
    assert.equal(records()[0].metadata.modelRequest.config.model, 'deepseek-custom');
    await translator.translate(spec); assert.equal(calls.length, 1);
    config = { ...config, model: 'deepseek-other' };
    await translator.translate(spec); assert.equal(calls.length, 2);
    config = { ...config, model: 'missing' };
    assert(!(await translator.availableProviders()).includes('deepseek-official'));
    await assert.rejects(translator.translate({ ...spec, text: 'missing' }), error => error.code === 'TRANSLATION_UNAVAILABLE');
    config = { ...config, model: 'deepseek-custom' }; configured = false;
    assert(!(await translator.availableProviders()).includes('deepseek-official'));
    await assert.rejects(translator.translate({ ...spec, text: 'credentials missing' }), error => error.code === 'TRANSLATION_UNAVAILABLE');

    config = { enabled: true, provider: 'foo', model: 'example' }; reasoning = true;
    assert((await translator.availableProviders()).includes('deepseek-official'));
    assert.equal(await translator.translate(spec), 'translated foo/example');
    assert.equal(records().at(-1).provider, 'foo');
    assert.equal(records().at(-1).metadata.modelRequest.config.provider, 'foo');
    const count = calls.length;
    await translator.translate(spec); assert.equal(calls.length, count);
    config = { ...config, provider: 'bar' };
    assert.equal(await translator.translate(spec), 'translated bar/example');
    assert.equal(calls.length, count + 1);
    config = { ...config, provider: 'foo', model: 'deepseek-flash' };
    assert.equal(await translator.translate(spec), 'translated foo/deepseek-flash');
    config = { ...config, model: 'example' }; customConfigured = false;
    await assert.rejects(translator.translate({ ...spec, text: 'custom credentials missing' }), error => error.code === 'TRANSLATION_REQUEST_FAILED');
    customConfigured = true;
    config = { ...config, model: 'missing' };
    assert(!(await translator.availableProviders()).includes('deepseek-official'));
    await assert.rejects(translator.translate({ ...spec, text: 'custom missing' }), error => error.code === 'TRANSLATION_UNAVAILABLE');
    assert.throws(() => translator.resolve({ ...spec, text: 'x'.repeat(translator.maxTextChars + 1) }), error => error.code === 'TRANSLATION_TEXT_LIMIT');

    config = { ...config, model: 'example' };
    for (const phase of ['request', 'result']) {
      failedWrite = phase;
      await assert.rejects(translator.translate({ ...spec, text: 'write failure ' + phase }), error => error.code === 'TRANSLATION_STORAGE_ERROR');
      failedWrite = undefined;
    }

    off(); configured = true; reasoning = false;
    assert.equal(await translator.translate({ ...spec, text: 'after unload' }), 'translated deepseek-official/deepseek-flash');
    console.log('PASS ' + version + ': 官方资格检查、第三方路由、原生会话缓存、同名模型隔离、推理文本过滤、输入限制与卸载恢复');
  } finally {
    off(); await fiber.dispose(); clearDshFacade();
  }
}
