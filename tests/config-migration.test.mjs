import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../node_modules/@dsh-plugin/dsh-loader/dist/services/config.js';
import { Config, resolvePluginConfig } from '../lib/config.js';
import { registerConfig, runtimeConfig } from '../lib/config-template.js';

test('旧路由迁移后保持实际模型和选项，清除选择和重新加载不会恢复旧值', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auxiliary-models-'));
  const directory = path.join(root, 'config', 'dsh-auxiliary');
  await mkdir(directory, { recursive: true });
  const keys = [
    'vision',
    'compact',
    'approve',
    'subagent',
    'title',
    'imagegen'
  ];
  const old = Config({
    vision: { maxTokens: 1234 },
    translation: { enabled: true, model: 'example' }
  });
  for (const key of keys) {
    Object.assign(old[key], {
      enabled: true,
      provider: 'foo',
      model: key,
      reasoningEffort: 'high'
    });
  }
  delete old.translation.provider;
  const file = path.join(directory, 'config.json');
  await writeFile(
    file,
    JSON.stringify({ formatVersion: 1, revision: 3, value: old })
  );
  const store = new ConfigStore(root);
  t.after(async () => {
    store.dispose();
    await rm(root, { recursive: true, force: true });
  });
  let handle = await registerConfig(
    store,
    { effect() {} },
    Config({}),
    '0.2.1-rc.1'
  );
  assert.equal(handle.get().revision, 4);
  let config = resolvePluginConfig(runtimeConfig(handle.get().value));
  for (const key of keys) {
    assert.equal(config[key].provider, 'foo');
    assert.equal(config[key].model, key);
    assert.equal(config[key].reasoningEffort, 'high');
  }
  assert.equal(config.vision.maxTokens, 1234);
  assert.equal(config.translation.provider, 'deepseek-official');
  assert.equal(config.translation.model, 'example');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.value.compact.selection, {
    provider: 'foo',
    model: 'compact',
    reasoningEffort: 'high'
  });
  assert.equal(Object.hasOwn(stored.value.compact, 'provider'), false);
  await handle.update({
    compact: { ...handle.get().value.compact, selection: null }
  });
  handle.dispose();
  handle = await registerConfig(
    store,
    { effect() {} },
    Config({ compact: { provider: 'bar', model: 'bootstrap' } }),
    '0.2.1-rc.1'
  );
  config = resolvePluginConfig(runtimeConfig(handle.get().value));
  assert.equal(handle.get().revision, 5);
  assert.equal(config.compact.provider, '');
  assert.equal(config.compact.enabled, true);
  assert.equal(config.approve.model, 'approve');
  const value = handle.get().value;
  value.title.selection = {
    provider: 'bar',
    model: 'changed',
    reasoningEffort: 'custom-level'
  };
  await handle.update(value);
  handle.dispose();
  handle = await registerConfig(
    store,
    { effect() {} },
    Config({}),
    '0.2.1-rc.1'
  );
  assert.equal(handle.get().revision, 6);
  assert.equal(
    runtimeConfig(handle.get().value).title.reasoningEffort,
    'custom-level'
  );
  handle.dispose();
});

test('迁移局部旧配置时，其他分组继续使用部署配置提供的默认模型', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auxiliary-models-'));
  const directory = path.join(root, 'config', 'dsh-auxiliary');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'config.json'),
    JSON.stringify({
      formatVersion: 1,
      revision: 1,
      value: { vision: { provider: 'foo', model: 'vision' } }
    })
  );
  const store = new ConfigStore(root);
  t.after(async () => {
    store.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const base = Config({
    compact: {
      enabled: true,
      provider: 'bar',
      model: 'compact',
      reasoningEffort: 'high'
    }
  });
  const handle = await registerConfig(
    store,
    { effect() {} },
    base,
    '0.2.1-rc.1'
  );
  const config = resolvePluginConfig(runtimeConfig(handle.get().value));
  assert.equal(config.vision.model, 'vision');
  assert.equal(config.compact.enabled, true);
  assert.equal(config.compact.provider, 'bar');
  assert.equal(config.compact.model, 'compact');
  assert.equal(config.compact.reasoningEffort, 'high');
  handle.dispose();
});

test('翻译路由保存第三方提供商后可重新加载，清除选择不会恢复旧模型', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auxiliary-models-'));
  const store = new ConfigStore(root);
  t.after(async () => { store.dispose(); await rm(root, { recursive: true, force: true }); });
  let handle = await registerConfig(store, { effect() {} }, Config({}), '0.2.1-rc.1');
  await handle.update({ translation: { enabled: true, selection: { provider: 'foo', model: 'example' } } });
  handle.dispose();
  handle = await registerConfig(store, { effect() {} }, Config({}), '0.2.1-rc.1');
  let config = resolvePluginConfig(runtimeConfig(handle.get().value));
  assert.equal(config.translation.provider, 'foo');
  assert.equal(config.translation.model, 'example');
  await handle.update({ translation: { enabled: true, selection: null } });
  handle.dispose();
  handle = await registerConfig(store, { effect() {} }, Config({ translation: { provider: 'bar', model: 'bootstrap' } }), '0.2.1-rc.1');
  config = resolvePluginConfig(runtimeConfig(handle.get().value));
  assert.equal(config.translation.provider, 'deepseek-official');
  assert.equal(config.translation.model, 'deepseek-flash');
  assert.equal(handle.get().value.translation.selection, null);
  handle.dispose();
});
