import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGpt62Model, installGpt62Instructions, preserveInstructionsPrefix, supportsGpt62InstructionsHost } from '../lib/gpt62-instructions.js';

test('only hosts with the verified prepare and descriptor seams are enabled', () => {
  for (const version of ['0.2.2-rc.5', '0.2.3-alpha.2', '0.2.3-alpha.2+build']) assert.ok(supportsGpt62InstructionsHost(version));
  for (const version of [undefined, '0.2.2-rc.4', '0.2.3-alpha.1', '0.2.3', '0.2.4-alpha.2']) assert.equal(supportsGpt62InstructionsHost(version), false);
});

test('only the GPT 6.2 family on Responses is eligible', () => {
  for (const name of ['gpt-6.2', 'gpt-6.2-sol', 'gpt-6.2-astra', 'GPT-6.2-Sol', 'gpt-6.2-2026-11-23']) assert.ok(isGpt62Model(name), name);
  for (const name of ['gpt-6', 'gpt-6.1', 'gpt-6.20', 'gpt-6.2x', 'other/gpt-6.2', 'claude', 'gpt-6.2.10']) assert.equal(isGpt62Model(name), false, name);
  const descriptor = Object.freeze({ api: 'openai-responses', compat: Object.freeze({ supportsAdditionalTools: true }) });
  assert.deepEqual(preserveInstructionsPrefix(descriptor, 'gpt-6.2-sol').compat, { supportsAdditionalTools: true, supportsMidConvoSystemMessages: true });
  assert.equal(descriptor.compat.supportsMidConvoSystemMessages, undefined);
  const existing = preserveInstructionsPrefix(descriptor, 'gpt-6.2-sol');
  assert.equal(preserveInstructionsPrefix(existing, 'gpt-6.2-astra'), existing);
  const chat = { ...descriptor, api: 'openai-completions' };
  assert.equal(preserveInstructionsPrefix(chat, 'gpt-6.2-sol'), chat);
});

test('capability applies at agent prepare and lazy dispatch, but not auxiliary calls or after unload', async () => {
  const config = Object.freeze({ provider: 'test', model: 'gpt-6.2-astra' });
  const request = Object.freeze({ ...config, sessionId: 'session' });
  const descriptor = { api: 'openai-responses', compat: { supportsAdditionalTools: true } };
  const adapter = {
    modelOf: () => descriptor,
    async prepareCall(provider, model) {
      const current = this.modelOf(null, provider, model);
      const inHistory = current.compat?.supportsMidConvoSystemMessages === true;
      return {
        model: { systemPromptUpdate: inHistory ? 'in-history' : undefined, toolUpdate: inHistory && current.compat.supportsAdditionalTools ? 'addition-only' : undefined },
        async *stream(request) { yield [request, adapter.modelOf(null, request.provider, request.model)]; },
      };
    },
  };
  const originalModelOf = adapter.modelOf;
  const originalAdapterPrepare = adapter.prepareCall;
  const runtime = {
    registration: () => ({ adapter }),
    async prepareCall(config) {
      const prepared = await adapter.prepareCall(config.provider, config.model);
      return Object.freeze({ ...prepared.model, stream: prepared.stream });
    },
  };
  const originalPrepare = runtime.prepareCall;
  const listeners = new Map();
  const agent = { ctx: { on: (id, fn, options) => { assert.equal(options.prepend, true); listeners.set(id, fn); return () => listeners.delete(id); } } };
  const install = installGpt62Instructions({
    llm: runtime,
    get: name => name === 'agents' ? { list: () => [agent] } : undefined,
    on: () => () => {},
  }, {
    method(target, key, wrap) {
      const original = target[key];
      target[key] = wrap(original);
      return { dispose() { target[key] = original; } };
    },
  });
  try {
    const unmarked = await runtime.prepareCall(config);
    assert.equal(unmarked.systemPromptUpdate, undefined);
    assert.equal((await Array.fromAsync(unmarked.stream(request)))[0][1], descriptor);
    assert.equal(await listeners.get('agent/request')({}, () => config), config);
    const prepared = await runtime.prepareCall(config);
    assert.equal(prepared.systemPromptUpdate, 'in-history');
    assert.equal(prepared.toolUpdate, undefined);
    const [[sent, outbound]] = await Array.fromAsync(prepared.stream(request));
    assert.equal(sent, request);
    assert.equal(outbound.compat.supportsMidConvoSystemMessages, true);
    assert.equal(outbound.compat.supportsAdditionalTools, false);
    const compaction = { ...request, purpose: 'compaction' };
    assert.equal((await Array.fromAsync(prepared.stream(compaction)))[0][1], descriptor);
    assert.deepEqual(descriptor.compat, { supportsAdditionalTools: true });
  } finally {
    install();
  }
  assert.equal(listeners.size, 0);
  assert.equal(adapter.modelOf, originalModelOf);
  assert.equal(adapter.prepareCall, originalAdapterPrepare);
  assert.equal(runtime.prepareCall, originalPrepare);
});
