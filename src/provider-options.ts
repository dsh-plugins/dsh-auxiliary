export const PROVIDER_SETTINGS = 'llm-pi-ai';
export const COMPACTION_FIELD = 'dshAuxiliaryCompaction';
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type CompactionMode = 'dsh' | 'kimi' | 'remote-v2';

export function isResponsesProtocol(value: unknown): boolean {
  return value === 'openai-responses' || value === 'openai-codex-responses' || value === 'azure-openai-responses';
}

export function compactionMode(value: unknown): CompactionMode | undefined {
  return value === 'dsh' || value === 'kimi' || value === 'remote-v2' ? value : undefined;
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function providerRow(section: unknown, provider: string): Record<string, unknown> | undefined {
  const providers = recordOf(recordOf(section)?.providers);
  return providers !== undefined && Object.hasOwn(providers, provider)
    ? recordOf(providers[provider]) : undefined;
}
