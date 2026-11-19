import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { HostAPI } from '@dsh-plugin/dsh-loader';
import { COMPACTION_FIELD, PROVIDER_SETTINGS, compactionMode, isResponsesProtocol, providerRow, type CompactionMode } from './provider-options.js';
import { installResponsesCompaction, remoteCheckpoint, type RemoteCheckpoint, type RemoteCompactionCall } from './responses-compaction.js';
import { deepFreeze } from './dsh.js';

/** A task handoff following the shape of Kimi Code's full-compaction instruction. */
const KIMI_HANDOFF = [
  'Write a self-contained handoff for the model continuing this conversation. Use the same language as the conversation and organize it around the task.',
  'Preserve the latest user goal, relevant earlier requests, constraints, settled decisions and their rationale.',
  'Record completed work with exact paths, commands, identifiers, key results and errors. Distinguish verified outcomes from assumptions and unresolved questions.',
  'Give the next concrete action and the remaining steps, including pitfalls and required output format. Leave out superseded attempts and long outputs that can be recovered from the session.',
  'Return only the handoff. Do not call tools.',
].join('\n\n');

type Request = GenerateOptions;
type Stream = AsyncIterable<StreamChunk>;

interface CompactionSession {
  requestHeader(): { config: Pick<Request, 'provider' | 'model' | 'reasoningEffort' | 'temperature' | 'stop'> } | undefined;
  deriveMessages?(): Request['messages'];
  snapshotEvents?(): ReadonlyArray<{ type: string; data: unknown }>;
  requestContext?(): { contextWindow?: number } | undefined;
}

interface ProviderSettings {
  describe?(): ReadonlyArray<{ ns: string; value?: unknown; user?: unknown; base?: unknown }>;
}

export function providerCompactionMode(ctx: Context, provider: string): CompactionMode | undefined {
  const section = (ctx.get('settings') as ProviderSettings | undefined)?.describe?.()
    .find(row => row.ns === PROVIDER_SETTINGS);
  const user = providerRow(section?.user, provider);
  if (!isResponsesProtocol(user?.api ?? providerRow(section?.value, provider)?.api)) return undefined;
  return compactionMode(user?.[COMPACTION_FIELD] ?? providerRow(section?.base, provider)?.[COMPACTION_FIELD]);
}

export function installProviderCompaction(ctx: Context, patch: HostAPI['patch']) {
  const remote = installResponsesCompaction(ctx.llm, patch);
  const active = new WeakSet<Request>();
  const sessions = ctx as unknown as { sessions?: { get(id: string): CompactionSession | undefined } };
  const stream = (options: Request): Stream => ctx.llm.stream(options as GenerateOptions);

  function route(options: Request, next: () => Stream, legacy: () => Stream): Stream {
    if (active.has(options)) return next();

    const session = options.sessionId === undefined ? undefined : sessions.sessions?.get(options.sessionId);
    const currentRoute = session?.requestHeader()?.config;
    const sourceProvider = currentRoute?.provider ?? options.provider;
    const mode = options.purpose === 'compaction' ? providerCompactionMode(ctx, sourceProvider) : undefined;
    if (mode === undefined || mode === 'dsh') {
      const replays = remoteCheckpoints(session, options);
      const send = mode === 'dsh' ? next : legacy;
      return replays.size === 0 ? send() : remote.run({ provider: options.provider, replays }, next);
    }

    const provider = sourceProvider;
    const replayOptions = currentRoute === undefined || currentRoute.provider === options.provider && currentRoute.model === options.model
      ? options : { ...options, provider, model: currentRoute.model };
    const last = options.messages.at(-1);
    if (last?.role !== 'user') throw new Error('dsh-auxiliary: compaction instruction is missing');
    // Retain the envelope already resolved for the replayed route. A header for
    // a different model can contain values that the source route does not accept.
    const controls = currentRoute?.provider === provider && currentRoute.model === replayOptions.model
      ? {
        ...currentRoute.reasoningEffort === undefined ? {} : { reasoningEffort: currentRoute.reasoningEffort },
        ...currentRoute.temperature === undefined ? {} : { temperature: currentRoute.temperature },
        ...currentRoute.stop === undefined ? {} : { stop: [...currentRoute.stop] },
      } : {};
    const selected = options.messages.slice(0, -1);
    const prefix = mode === 'kimi' ? kimiHistory(ctx, session, selected, options.maxTokens) : selected;
    const replays = remoteCheckpoints(session, { ...replayOptions, messages: prefix });
    const requestId = crypto.randomUUID();
    const call: RemoteCompactionCall = {
      provider, replays,
      ...(mode === 'remote-v2' ? { trigger: { marker: `[dsh-auxiliary:compact:${requestId}]`, provider, model: replayOptions.model } } : {}),
    };
    const rewritten = deepFreeze({
      ...replayOptions,
      ...controls,
      messages: [
        ...prefix,
        { ...last, content: [{ type: 'text' as const, text: call.trigger?.marker ?? KIMI_HANDOFF }] },
      ],
      // Clone caller-owned option arrays before freezing the new envelope.
      ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    });
    active.add(rewritten);
    const send = () => stream(rewritten);
    return call.trigger !== undefined || replays.size > 0 ? remote.run(call, send) : send();
  }

  return { route, dispose: remote.dispose };
}

/** Kimi-style whole-history handoff, bounded by the last routed model's context budget. */
function kimiHistory(ctx: Context, session: CompactionSession | undefined, selected: Request['messages'], maxTokens = 0): Request['messages'] {
  const history = session?.deriveMessages?.();
  const window = session?.requestContext?.()?.contextWindow;
  const meter = ctx.get('tokenMeter') as { measure?(input: CompactionSession): { totalTokens: number } } | undefined;
  if (history === undefined || window === undefined || meter?.measure === undefined || session === undefined) return selected;
  // The selected range must actually be a prefix, including the system head.
  if (!selected.every((message, index) => message.id === history[index]?.id)) return selected;
  const tokens = meter.measure(session).totalTokens;
  return tokens + maxTokens + KIMI_HANDOFF.length <= window ? history : selected;
}

function remoteCheckpoints(session: CompactionSession | undefined, options: Request): Map<string, RemoteCheckpoint> {
  const replays = new Map<string, RemoteCheckpoint>();
  if (session?.snapshotEvents === undefined) return replays;
  // Only checkpoint messages created by DSH can request replay of stored state.
  const markers = new Set(options.messages.flatMap(message => message.role === 'user'
    && 'source' in message && String(message.source?.kind) === 'compact-checkpoint'
    ? message.content.flatMap(block => block.type === 'text' ? remoteCheckpoint.markerIn(block.text) ?? [] : [])
    : []));
  if (markers.size === 0) return replays;
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0 && replays.size < markers.size; index -= 1) {
    const event = events[index];
    if (event.type !== 'compaction/summary') continue;
    const data = event.data as { rawOutput?: Array<{ type: string; text?: string }> };
    for (const part of data.rawOutput ?? []) {
      if (part.type !== 'reasoning' || part.text === undefined) continue;
      const checkpoint = remoteCheckpoint.decode(part.text);
      if (checkpoint === undefined || checkpoint.provider !== options.provider || checkpoint.model !== options.model
        || !markers.has(checkpoint.marker)) continue;
      replays.set(checkpoint.marker, checkpoint.item);
    }
  }
  return replays;
}
