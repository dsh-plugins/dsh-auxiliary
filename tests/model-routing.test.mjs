import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, resolvePluginConfig } from '../lib/config.js';
import { createConfigTemplate, runtimeConfig } from '../lib/config-template.js';
import { defaultsFor } from '@dsh-plugin/dsh-loader/config';
import { installCompactRouter } from '../lib/compact-router.js';
import { installTitleRouter } from '../lib/title-router.js';
import { registerApproveRouter } from '../lib/approve-router.js';
import { registerSubagentRouter } from '../lib/subagent-router.js';
import { registerVisionTool } from '../lib/vision-tool.js';
import { setDshFacade, clearDshFacade } from '../lib/dsh.js';

for (const [key, install, purpose] of [
  ['compact', installCompactRouter, 'compaction'],
  ['title', installTitleRouter, 'session-title'],
  ['approve', registerApproveRouter, undefined]
]) {
  test(`${key} 请求使用选择器的模型与推理等级，清除等级后恢复提供商默认行为`, () => {
    const value = defaultsFor(createConfigTemplate(Config({})).fields);
    value[key].enabled = true;
    value[key].selection = {
      provider: 'foo',
      model: 'example',
      reasoningEffort: 'custom-level'
    };
    let listener;
    const calls = [];
    const ctx = {
      on: (_name, fn) => {
        listener = fn;
        return () => {};
      },
      llm: {
        stream: (options) => {
          calls.push(options);
          return options;
        }
      }
    };
    install(ctx, () => resolvePluginConfig(runtimeConfig(value)));
    const input = {
      provider: 'foo',
      model: 'example',
      reasoningEffort: 'main-level',
      purpose,
      temperature: 0,
      system: 'example',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '>>> APPROVAL REQUEST START' }]
        }
      ]
    };
    assert.equal(
      listener(input, () => 'unchanged').reasoningEffort,
      'custom-level'
    );
    delete value[key].selection.reasoningEffort;
    assert.equal(listener(input, () => 'unchanged').reasoningEffort, undefined);
    const selected = calls.at(-1);
    assert.equal(
      listener(selected, () => 'unchanged'),
      'unchanged'
    );
    assert.equal(input.reasoningEffort, 'main-level');
    value[key].selection = null;
    assert.equal(
      listener(input, () => 'unchanged'),
      'unchanged'
    );
  });
}

test('已创建的子代理按下一次请求读取更新后的模型与推理等级', async (t) => {
  setDshFacade({
    dsh: { subagent: { delegationDepthOf: () => 1 } },
    llm: { deepFreeze: (value) => value }
  });
  t.after(clearDshFacade);
  const value = defaultsFor(createConfigTemplate(Config({})).fields);
  value.subagent = {
    enabled: true,
    selection: { provider: 'foo', model: 'example', reasoningEffort: 'high' }
  };
  let created, request;
  registerSubagentRouter(
    {
      on: (_name, fn) => {
        created = fn;
        return () => {};
      }
    },
    () => resolvePluginConfig(runtimeConfig(value))
  );
  created({
    agent: {
      ctx: {
        on: (_name, fn) => {
          request = fn;
        }
      }
    }
  });
  const input = {
    provider: 'bar',
    model: 'parent',
    reasoningEffort: 'parent-level'
  };
  assert.equal((await request({}, async () => input)).reasoningEffort, 'high');
  value.subagent.selection = { provider: 'foo', model: 'changed' };
  const next = await request({}, async () => input);
  assert.equal(next.model, 'changed');
  assert.equal(next.reasoningEffort, undefined);
  value.subagent.selection = null;
  assert.equal(await request({}, async () => input), input);
});

test('视觉工具实际请求携带选择器保存的模型和推理等级', async (t) => {
  class Assembler {
    finish = { kind: 'stop' };
    push() {}
    blocks() {
      return [{ type: 'text', text: 'example' }];
    }
  }
  setDshFacade({
    dsh: {
      tools: { defineTool: (value) => value },
      timeout: { deadline: (signal) => ({ signal, [Symbol.dispose]() {} }) },
      llm: { BlockAssembler: Assembler }
    },
    llm: {
      deepFreeze: (value) => value,
      createUserMessage: (value) => ({ role: 'user', ...value })
    }
  });
  t.after(clearDshFacade);
  const value = defaultsFor(createConfigTemplate(Config({})).fields);
  value.vision.selection = {
    provider: 'foo',
    model: 'vision',
    reasoningEffort: 'custom-level'
  };
  const tools = new Map(),
    calls = [];
  const ctx = {
    on: () => () => {},
    systemPrompt: { section: () => () => {} },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      }
    },
    attachments: { readImage: async (ref) => ({ ref }) },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['image'] }),
      async *stream(options) {
        calls.push(options);
        yield {};
      }
    }
  };
  const dispose = registerVisionTool(ctx, () =>
    resolvePluginConfig(runtimeConfig(value))
  );
  t.after(dispose);
  const ref = {
    attachmentId: 'foo',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1
  };
  const result = await tools
    .get('describe_image')
    .execute(
      { ref: JSON.stringify(ref) },
      { signal: new AbortController().signal }
    );
  assert.equal(result.content, 'example');
  assert.equal(calls[0].provider, 'foo');
  assert.equal(calls[0].model, 'vision');
  assert.equal(calls[0].reasoningEffort, 'custom-level');
});
