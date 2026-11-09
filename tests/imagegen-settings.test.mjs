import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerProfile } from '../lib/imagegen-tool.js';

const profile = { baseURL: 'https://example.test/v1', apiKeyEnv: 'EXAMPLE_IMAGE_KEY' };
const route = { provider: 'lanqin-gpt', displayName: 'Lanqin', settingsNs: 'llm-pi-ai', settingsPath: ['providers'] };

/** Context stub exposing exactly the seams providerProfile() reads. */
const contextOf = (settings, routes = [route]) => ({
  get: (name) => (name === 'settings' ? settings : undefined),
  llm: { listConfigurableProviders: () => routes },
});

test('dsh 0.1.x: provider profile comes from the settings namespace accessor', () => {
  const settings = { get: (ns) => (ns === 'llm-pi-ai' ? { providers: { 'lanqin-gpt': profile } } : undefined) };
  assert.deepEqual(providerProfile(contextOf(settings), 'lanqin-gpt'), profile);
});

test('dsh 0.2.x: provider profile comes from the describe() entry value', () => {
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'lanqin-gpt': profile } } }] };
  assert.deepEqual(providerProfile(contextOf(settings), 'lanqin-gpt'), profile);
});

test('a host without a settings service degrades to undefined instead of throwing', () => {
  assert.equal(providerProfile(contextOf(undefined), 'lanqin-gpt'), undefined);
});

test('an unconfigured provider route degrades to undefined', () => {
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} } }] };
  assert.equal(providerProfile(contextOf(settings), 'missing'), undefined);
});

test('the directory namespace wins over the llm-pi-ai default', () => {
  const settings = { get: (ns) => (ns === 'custom-ns' ? { providers: { 'lanqin-gpt': profile } } : undefined) };
  assert.deepEqual(providerProfile(contextOf(settings, [{ ...route, settingsNs: 'custom-ns' }]), 'lanqin-gpt'), profile);
});
