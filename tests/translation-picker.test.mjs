import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);

test('翻译选择器只显示官方目录，保留错误并取消迟到请求', async (t) => {
  const dom = new JSDOM('<body></body>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const cleanups = [];
  t.after(() => {
    for (const dispose of cleanups.reverse()) {
      dispose?.();
    }
    dom.window.close();
  });
  let declaration;
  dom.window.__ModuleLoader__ = {
    load: (entry) => {
      declaration = entry;
    }
  };
  dom.window.__dshLoader__ = { dshVersion: '0.2.1-rc.1' };
  dom.window.eval(
    await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  );
  const selector = () => null;
  const client = declaration.factory((id) =>
    id === '@dsh-plugin/dsh-loader/client'
      ? { ModelSelect: selector, Icon: () => null, DshMenu: () => null }
      : require(id)
  );
  const official = {
    id: 'deepseek-official',
    name: '官方 API',
    models: [
      {
        id: 'example',
        name: 'Example',
        reasoning: { efforts: [{ id: 'high', name: 'High' }] }
      }
    ]
  };
  let models = async () => ({
    result: {
      ok: true,
      value: {
        groups: [official, { id: 'foo', name: 'Foo', models: [] }],
        failures: [
          { id: 'deepseek-official', name: '官方 API', message: 'example' },
          { id: 'foo', name: 'Foo', message: 'bar' }
        ]
      }
    }
  });
  let registered;
  const api = {
    llm: {
      models: () => models(),
      providers: async () => ({
        result: { ok: true, value: { providers: [] } }
      })
    }
  };
  client.apply({
    effect: (fn) => cleanups.push(fn()),
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => ({ api }),
    dshLoaderUi: {
      config: {
        registerDialog: (_owner, options) => {
          registered = options;
        }
      },
      onDomSettled: () => () => {}
    }
  });
  assert.deepEqual(Array.from(registered.field), ['translation', 'selection']);
  const value = { provider: 'deepseek-official', model: 'example' };
  let changed;
  const control = registered.component({
    value,
    setValue: (next) => {
      changed = next;
    },
    saving: true,
    errors: {}
  });
  assert.equal(control.type, selector);
  assert.equal(control.props.disabled, true);
  control.props.onChange(value);
  assert.equal(changed, value);
  const result = await control.props.loadModels(new AbortController().signal);
  assert.deepEqual(
    Array.from(result.groups, (group) => group.id),
    ['deepseek-official']
  );
  assert.equal(result.groups[0].models[0].reasoning, undefined);
  assert.equal(result.failures.length, 1);
  assert.equal(official.models[0].reasoning.efforts[0].id, 'high');
  models = async () => ({
    result: { ok: false, error: { code: 'unavailable', message: '目录不可用' } }
  });
  await assert.rejects(
    control.props.loadModels(new AbortController().signal),
    /目录不可用/
  );
  let complete;
  models = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const controller = new AbortController();
  const pending = control.props.loadModels(controller.signal);
  controller.abort();
  complete({ result: { ok: true, value: { groups: [], failures: [] } } });
  await assert.rejects(pending, /abort/i);
});
