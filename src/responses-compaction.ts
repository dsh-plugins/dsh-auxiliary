import { AsyncLocalStorage } from 'node:async_hooks';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { HostAPI } from '@dsh-plugin/dsh-loader';
import { isResponsesProtocol, recordOf } from './provider-options.js';

type WireObject = Record<string, unknown>;
export type RemoteCheckpoint = { type: 'compaction'; encrypted_content: string; id?: string };
type Stream = AsyncIterable<StreamChunk>;

export interface RemoteCompactionCall {
  provider: string;
  replays: ReadonlyMap<string, RemoteCheckpoint>;
  trigger?: { marker: string; provider: string; model: string };
  result?: RemoteCheckpoint;
  completed?: boolean;
}

interface PiStreamOptions {
  onPayload?(payload: unknown, model: unknown): unknown;
  onProviderStreamEvent?(event: unknown, model: unknown): unknown;
}

interface PiModels {
  streamSimple(model: { api?: string }, context: unknown, options?: PiStreamOptions): unknown;
}

interface PiAdapter {
  current?(): { models?: PiModels };
}

interface LlmRegistry {
  registration?(provider: string): { adapter?: PiAdapter };
}

const CHECKPOINT = /\[dsh-auxiliary:checkpoint:([\da-f-]{36})\]/u;
const RECORD_PREFIX = 'dsh-auxiliary:responses-compaction:';

function checkpoint(value: unknown): RemoteCheckpoint | undefined {
  const item = recordOf(value);
  if (item?.type !== 'compaction' || typeof item.encrypted_content !== 'string' || !item.encrypted_content) return undefined;
  return {
    type: 'compaction',
    encrypted_content: item.encrypted_content,
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
  };
}

export const remoteCheckpoint = {
  markerIn(text: string): string | undefined {
    return CHECKPOINT.exec(text)?.[0];
  },
  encode(marker: string, provider: string, model: string, item: RemoteCheckpoint): string {
    return RECORD_PREFIX + JSON.stringify({ marker, provider, model, item });
  },
  decode(text: string): { marker: string; provider: string; model: string; item: RemoteCheckpoint } | undefined {
    if (!text.startsWith(RECORD_PREFIX)) return undefined;
    try {
      const value = recordOf(JSON.parse(text.slice(RECORD_PREFIX.length)));
      const marker = value?.marker;
      const item = checkpoint(value?.item);
      return typeof marker === 'string' && CHECKPOINT.test(marker) && item !== undefined
        && typeof value?.provider === 'string' && typeof value.model === 'string'
        ? { marker, provider: value.provider, model: value.model, item } : undefined;
    } catch {
      return undefined;
    }
  },
};

function contentText(value: unknown): string {
  const item = recordOf(value);
  if (typeof item?.content === 'string') return item.content;
  return Array.isArray(item?.content)
    ? item.content.map(part => recordOf(part)?.text ?? '').join('') : '';
}

/** Replace only trusted checkpoint messages after the SDK builds the regular Responses payload. */
export function compactionPayload(payload: unknown, call: RemoteCompactionCall): WireObject {
  const request = recordOf(payload);
  if (request === undefined || !Array.isArray(request.input)) {
    throw new Error('dsh-auxiliary: Responses compaction requires an input array');
  }
  const replayed = new Set<string>();
  let triggered = false;
  const input = request.input.flatMap((value: unknown): unknown[] => {
    const item = recordOf(value);
    if (item?.role !== 'user') return [value];
    const text = contentText(item);
    const marker = remoteCheckpoint.markerIn(text);
    const replay = marker === undefined ? undefined : call.replays.get(marker);
    if (marker !== undefined && replay !== undefined
      && /^This is an automatically generated checkpoint/u.test(text)) {
      replayed.add(marker);
      return [replay];
    }
    if (call.trigger !== undefined && text.includes(call.trigger.marker)) {
      if (triggered) throw new Error('dsh-auxiliary: duplicate Responses compaction instruction');
      triggered = true;
      if (text === call.trigger.marker) return [];
      if (!Array.isArray(item.content)) throw new Error('dsh-auxiliary: Responses SDK merged the compaction instruction');
      const content = item.content.filter(part => recordOf(part)?.text !== call.trigger?.marker);
      if (content.length === item.content.length) throw new Error('dsh-auxiliary: Responses SDK merged the compaction instruction');
      return content.length === 0 ? [] : [{ ...item, content }];
    }
    return [value];
  });
  if (replayed.size !== call.replays.size) throw new Error('dsh-auxiliary: Responses SDK did not preserve the checkpoint boundaries');
  if (call.trigger !== undefined) {
    if (!triggered) throw new Error('dsh-auxiliary: Responses SDK did not pass the compaction instruction');
    input.push({ type: 'compaction_trigger' });
  }
  return { ...request, input };
}

function readProviderEvent(call: RemoteCompactionCall, input: unknown): void {
  const event = recordOf(input);
  if (event?.type === 'response.output_item.done') {
    call.result ??= checkpoint(event.item);
  } else if (event?.type === 'response.completed' || event?.type === 'response.done') {
    const response = recordOf(event.response);
    if (response?.status !== 'completed' && !(event.type === 'response.completed' && response?.status === undefined)) return;
    const output = response?.output;
    if (Array.isArray(output)) call.result ??= output.map(checkpoint).find(item => item !== undefined);
    call.completed = true;
  }
}

/** Use pi-ai's payload/event hooks so auth, tools, media, transport and usage stay on the host adapter. */
export function installResponsesCompaction(llm: object, patch: HostAPI['patch']) {
  const original = Reflect.get(llm, Symbol.for('cordis.original')) ?? llm;
  const runtime = original as LlmRegistry;
  const scope = new AsyncLocalStorage<RemoteCompactionCall>();
  const modelsPatched = new WeakSet<PiModels>();
  const adaptersPatched = new WeakSet<PiAdapter>();
  const disposers: Array<() => void> = [];

  function hookModels(models: PiModels): void {
    if (modelsPatched.has(models)) return;
    const handle = patch.method(models, 'streamSimple', upstream => function (this: PiModels, model, context, options) {
      const call = scope.getStore();
      if (call === undefined) return upstream.call(this, model, context, options);
      if (!isResponsesProtocol(model.api)) throw new Error('dsh-auxiliary: selected model does not use Responses');
      return upstream.call(this, model, context, {
        ...options,
        async onPayload(payload, descriptor) {
          const originalPayload = await options?.onPayload?.(payload, descriptor) ?? payload;
          return compactionPayload(originalPayload, call);
        },
        async onProviderStreamEvent(event, descriptor) {
          readProviderEvent(call, event);
          await options?.onProviderStreamEvent?.(event, descriptor);
        },
      });
    });
    modelsPatched.add(models);
    disposers.push(() => handle.dispose());
  }

  function prepare(call: RemoteCompactionCall): void {
    const adapter = runtime.registration?.(call.provider)?.adapter;
    if (adapter?.current === undefined) throw new Error('dsh-auxiliary: this host does not expose Responses compaction transport hooks');
    if (!adaptersPatched.has(adapter)) {
      const handle = patch.method(adapter, 'current', upstream => upstream && function (this: PiAdapter) {
        const snapshot = upstream.call(this);
        if (scope.getStore() !== undefined && snapshot.models !== undefined) hookModels(snapshot.models);
        return snapshot;
      });
      adaptersPatched.add(adapter);
      disposers.push(() => handle.dispose());
    }
    // Ordinary requests may already hold this snapshot from prepareCall().
    const models = adapter.current()?.models;
    if (models === undefined || typeof models.streamSimple !== 'function') {
      throw new Error('dsh-auxiliary: Responses adapter stream is unavailable');
    }
    hookModels(models);
  }

  async function* run(call: RemoteCompactionCall, send: () => Stream): AsyncGenerator<StreamChunk> {
    const iterator = scope.run(call, () => {
      prepare(call);
      return send()[Symbol.asyncIterator]();
    });
    try {
      for (;;) {
        const next = await scope.run(call, () => iterator.next());
        if (next.done) return;
        const chunk = next.value;
        const trigger = call.trigger;
        if (trigger === undefined) {
          yield chunk;
        } else if (chunk.type === 'usage') {
          yield chunk;
        } else if (chunk.type === 'finish') {
          // The adapter considers a successful response with no text/tool
          // blocks empty. The native checkpoint is received via the SDK event.
          const checkpointOnly = call.completed === true && call.result !== undefined
            && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'EMPTY_RESPONSE';
          if (chunk.reason.kind === 'stop' || checkpointOnly) {
            if (call.result === undefined) throw new Error('dsh-auxiliary: provider returned no Responses V2 compaction item');
            const marker = trigger.marker.replace(':compact:', ':checkpoint:');
            yield { type: 'block-end', index: 0, block: { type: 'text', text: `Responses checkpoint (available on its original provider/model) ${marker}` } };
            yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: remoteCheckpoint.encode(marker, trigger.provider, trigger.model, call.result) } };
          }
          yield checkpointOnly ? { type: 'finish', reason: { kind: 'stop' } } : chunk;
        }
      }
    } finally {
      await scope.run(call, () => iterator.return?.());
    }
  }

  return { run, dispose: () => { for (const dispose of disposers.reverse()) dispose(); } };
}
