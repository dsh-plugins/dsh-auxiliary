import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const ok = value => ({ result: { ok: true, value } });
const editCard = () => `
  <li><span>Gateway</span><div class="editor">
    <div><span>API 协议</span><select aria-label="API 协议">
      <option value="openai-responses">OpenAI Responses</option>
      <option value="openai-completions">OpenAI Chat Completions</option>
    </select></div>
    <div role="group"><span id="gateway-retry-failure-label">重试策略</span><select aria-labelledby="gateway-retry-failure-label"></select></div>
    <div><button type="button">取消</button><button type="button">保存</button></div>
  </div></li>`;
const createCard = () => `
  <div class="editor">
    <input aria-label="Provider ID" value="fresh">
    <div><span>API 协议</span><select aria-label="API 协议"><option value="openai-responses">OpenAI Responses</option></select></div>
    <div><button type="button">取消</button><button type="button">创建提供商</button></div>
  </div>`;

async function until(predicate) {
  for (let step = 0; step < 100; step += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('provider settings did not settle');
}

function setup(t, html) {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const child = window.document;
  const cleanup = [];
  t.after(() => { for (const dispose of cleanup.reverse()) dispose?.(); window.close(); });

  let declaration;
  window.__dshLoader__ = { dshVersion: '0.2.2-alpha.2' };
  window.__ModuleLoader__ = { load: value => { declaration = value; } };
  window.eval(bundle);
  const plugin = declaration.factory(id => id === '@dsh-plugin/dsh-loader/client'
    ? { Icon: () => null, DshMenu: () => null } : require(id));
  const config = { providers: { gateway: { api: 'openai-responses', models: [], reasoning: 'low' } } };
  let revision = 1;
  const calls = [];
  const api = {
    llm: {
      providers: async () => ok({ providers: [{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai' }] }),
    },
    settings: {
      describe: async () => ok({ writable: true, namespaces: [{ ns: 'llm-pi-ai', value: config, user: config, revision }] }),
      mutate: async args => { calls.push(args); return ok({}); },
    },
  };
  let dictionaries;
  plugin.apply({
    effect: run => cleanup.push(run()),
    locale: { register(_id, values) { dictionaries = values.zh; return () => {}; }, bind: () => key => dictionaries[key] },
    get: () => ({ api }),
    dshLoaderUi: { config: { registerDialog: () => () => {} } },
  });

  const choose = (node, value) => {
    node.value = value;
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const fields = () => ({
    reasoning: child.querySelector('[aria-label="默认推理强度"]'),
    compaction: child.querySelector('[aria-label="压缩引擎"]'),
  });
  function submit(action) {
    const button = [...child.querySelectorAll('button')].find(node => node.textContent === action);
    button.addEventListener('click', () => {
      if (action === '创建提供商') {
        config.providers.fresh = { api: 'openai-responses', models: [] };
        revision += 1;
      }
      button.closest('.editor').remove();
    }, { once: true });
    button.click();
  }
  return { child, calls, choose, fields, submit };
}

test('Responses edit shows both dropdowns in order, hides compression on protocol change and saves both choices', async t => {
  const { child, calls, choose, fields, submit } = setup(t, editCard());
  await until(() => fields().compaction);
  const { reasoning, compaction } = fields();
  const protocol = child.querySelector('[aria-label="API 协议"]');
  const retry = child.querySelector('select[aria-labelledby="gateway-retry-failure-label"]');
  assert.equal(protocol.parentElement.nextElementSibling, reasoning.parentElement);
  assert.equal(retry.parentElement.nextElementSibling, compaction.parentElement);
  assert.deepEqual([...reasoning.options].slice(1).map(option => option.value),
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(reasoning.value, 'low');
  assert.deepEqual([...compaction.options].map(option => [option.value, option.textContent]), [
    ['dsh', '原始 DSH 压缩'], ['kimi', 'Kimi Code 压缩策略'], ['remote-v2', '远程压缩 V2'],
  ]);
  choose(compaction, 'remote-v2');
  choose(protocol, 'openai-completions');
  await until(() => fields().compaction === null);
  choose(protocol, 'openai-responses');
  await until(() => fields().compaction !== null);
  assert.equal(fields().compaction.value, 'remote-v2');
  choose(reasoning, 'max');
  assert.equal(calls.length, 0);
  submit('保存');
  await until(() => calls.length === 1);
  assert.equal(calls[0].expectedRevision, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].ops)), [
    { op: 'set', path: ['providers', 'gateway', 'reasoning'], value: 'max' },
    { op: 'set', path: ['providers', 'gateway', 'dshAuxiliaryCompaction'], value: 'remote-v2' },
  ]);
});

test('create shows only reasoning, saves it after creation and does not save on cancel', async t => {
  const { child, calls, choose, fields, submit } = setup(t, createCard());
  await until(() => fields().reasoning);
  assert.equal(fields().compaction, null);
  choose(fields().reasoning, 'high');
  submit('取消');
  child.body.insertAdjacentHTML('beforeend', createCard());
  await until(() => fields().reasoning);
  assert.equal(calls.length, 0);
  assert.equal(fields().reasoning.value, '');
  choose(fields().reasoning, 'xhigh');
  submit('创建提供商');
  await until(() => calls.length === 1);
  assert.equal(calls[0].expectedRevision, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].ops)), [
    { op: 'set', path: ['providers', 'fresh', 'reasoning'], value: 'xhigh' },
  ]);
});
