/**
 * The model-facing `inspect_image` tool: read a local image file, commit it
 * through the attachment seam, and ask the selected configured vision model.
 * When the tool is enabled it remains registered even without a selected route,
 * preserving the existing execution-time error and pass-through behavior while
 * route values are read from the current resolved snapshot for each call.
 *
 * @module dsh-auxiliary/vision-tool
 */
import type { Context } from '@deepseek-ai/cordis';
import type { BlockAssembler, ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm';
// Type-only side-effect imports: these pull the `declare module 'cordis'`
// Context augmentations (`ctx.fs`, `ctx.tools`) the plugin relies on. They are
// erased at compile time, so they never reach the runtime import graph.
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-tools';
import type { ImageMediaType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { deepFreeze, dsh, llm } from './dsh.js';
import { PLUGIN_NAME, type ResolvedPluginConfig } from './config.js';

/**
 * `ToolArgsError` 的构造入口。
 *
 * 类本身由 dshloader 的 `dsh` 门面在启动期解析（它是 `@deepseek-ai/dsh-tools`
 * 的模块级导出，不是服务方法），因此不能在模块求值期拿到；本 helper 把「取类 +
 * new」收在一处，调用点保持原样可读。
 */
function argsError(messages: string[]): Error {
  const ToolArgsError = dsh().tools.ToolArgsError;
  return new ToolArgsError(messages);
}

/** Timeout code stamped on vision-tool aborts. */
const VISION_TOOL_TIMEOUT_CODE = 'AUX_VISION_TOOL_TIMEOUT';

/** Default question when the model does not supply one. */
const DEFAULT_QUESTION = 'Describe this image in detail, including any visible text, UI elements, diagrams, or code.';

/** Extension -> accepted raster media type. */
const EXTENSION_MEDIA: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

/** Validated model arguments of one `inspect_image` call. */
interface InspectImageArgs {
  path: string;
  question?: string;
}

/** Parse and validate raw model arguments. */
function parseArgs(args: unknown): InspectImageArgs {
  const value = args as { path?: unknown; question?: unknown } | null;
  if (value === null || typeof value !== 'object' || typeof value.path !== 'string' || value.path.length === 0) {
    throw argsError(['inspect_image: "path" must be a non-empty string']);
  }
  if (value.question !== undefined && typeof value.question !== 'string') {
    throw argsError(['inspect_image: "question" must be a string when present']);
  }
  return { path: value.path, question: value.question };
}

/** Parse and validate the `ref` argument of a `describe_image` call. */
function parseImageRef(raw: string): ImageAttachmentRef {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw argsError(['describe_image: "ref" must be the exact JSON from the [image: ...] reference in the conversation']);
  }
  const ref = value as { attachmentId?: unknown; mediaType?: unknown; bytes?: unknown; width?: unknown; height?: unknown; name?: unknown } | null;
  if (
    ref === null || typeof ref !== 'object'
    || typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0
    || typeof ref.mediaType !== 'string'
    || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes)
    || typeof ref.width !== 'number' || !Number.isInteger(ref.width) || ref.width <= 0
    || typeof ref.height !== 'number' || !Number.isInteger(ref.height) || ref.height <= 0
  ) {
    throw argsError(['describe_image: "ref" must be a complete image reference (attachmentId, mediaType, bytes, width, height)']);
  }
  return {
    attachmentId: ref.attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: ref.mediaType as ImageAttachmentRef['mediaType'],
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(typeof ref.name === 'string' && ref.name.length > 0 ? { name: ref.name } : {})
  };
}

/** Derive the accepted media type from a file path's extension. */
function mediaTypeForPath(path: string): ImageMediaType {
  const extension = (path.split('.').pop() ?? '').toLowerCase();
  const media = EXTENSION_MEDIA[extension];
  if (media === undefined) {
    throw new Error(`inspect_image: unsupported image extension ".${extension}" (supported: png/jpg/jpeg/webp/gif)`);
  }
  return media;
}

/** Strip directory components from a file path for display. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Result of one vision-model call: assembled text plus a truncation flag. */
interface VisionAnswer {
  /** Concatenated text blocks produced by the model. */
  text: string;
  /** Whether the model hit the configured maxTokens before finishing. */
  truncated: boolean;
}

/** Extract the assembled text blocks of one call. */
function blocksText(assembler: BlockAssembler): string {
  return assembler.blocks().filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text).join(' ');
}

/** Run one one-shot call through the selected vision route and return its text answer. */
async function askVision(
  ctx: Context,
  get: () => ResolvedPluginConfig,
  attachment: ImageAttachmentRef,
  question: string,
  signal: AbortSignal,
  sessionId: GenerateOptions['sessionId'],
  toolName: string
): Promise<VisionAnswer> {
  const vision = get().vision;
  if (vision.provider === undefined || vision.model === undefined) {
    throw new Error(`${toolName}: no vision provider/model is selected; select both in dsh-auxiliary settings before using this tool`);
  }
  const messages = [
    llm().createUserMessage({
      content: [
        { type: 'image', attachment },
        { type: 'text', text: question }
      ],
      source: { kind: 'plugin', plugin: PLUGIN_NAME }
    })
  ];
  const timeout = dsh().timeout.deadline(signal, get().tool.timeoutMs, VISION_TOOL_TIMEOUT_CODE);
  try {
    const modelInfo = await ctx.llm.resolveModelInfo(vision.provider, vision.model, timeout.signal);
    if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
      throw new Error(`${toolName}: selected model "${vision.provider}/${vision.model}" does not support image input`);
    }
    const assembler = new (dsh().llm.BlockAssembler)();
    for await (const chunk of ctx.llm.stream(deepFreeze({
      provider: vision.provider,
      model: vision.model,
      messages,
      maxTokens: vision.maxTokens,
      ...(sessionId !== undefined ? { sessionId } : {}),
      signal: timeout.signal
    }))) {
      assembler.push(chunk);
    }
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`${toolName}: vision model call failed (${finish.failure.code}): ${finish.failure.message}`);
    }
    if (finish.kind === 'tool-calls') {
      throw new Error(`${toolName}: vision model unexpectedly requested a tool`);
    }
    const text = blocksText(assembler);
    if (text.trim().length === 0) {
      throw new Error(`${toolName}: vision model produced no text${finish.kind === 'max-tokens' ? ' before hitting maxTokens' : ''}`);
    }
    return { text, truncated: finish.kind === 'max-tokens' };
  } finally {
    timeout[Symbol.dispose]();
  }
}

/**
 * Register the `inspect_image` and `describe_image` tools plus system-prompt
 * guidance.
 *
 * @returns a disposer that removes both registrations made by this function.
 */
export function registerVisionTool(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  const disposePrompt = ctx.systemPrompt.section({
    name: 'tool:inspect_image',
    order: 160,
    text: 'Use the inspect_image tool to analyze local image files (screenshots, photos, diagrams) with the selected vision model. Pass the file path and an optional question; the answer comes back as text. When the conversation contains an image reference like [image: {...}], the image was attached to the chat: call describe_image with the exact JSON from that reference to get the image content as text.'
  });
  const disposeTool = ctx.tools.register(dsh().tools.defineTool({
    name: 'inspect_image',
    description: 'Analyze a local image file with the selected vision model. Pass an absolute or workspace-relative path to a PNG/JPEG/WebP/GIF file and an optional question; returns the vision model\'s answer as text.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute or workspace-relative path to the image file.'
      },
      question: {
        type: 'string',
        description: 'What to ask about the image. Defaults to a general description.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          path: { type: 'string' },
          truncated: { type: 'boolean' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.truncated ? `${value.content ?? ''}\n\n[note: the vision model output was truncated at maxTokens]` : value.content ?? '' }],
      presentationMeta: (_args, value) => value
    },
    timeoutMs: get().tool.timeoutMs,
    async execute(args, exec) {
      const input = parseArgs(args);
      const policy = get().tool;
      const cwd = exec.agent?.session.header.cwd;
      const target = await ctx.fs.resolve(input.path, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined || info.type !== 'file') {
        throw new Error(`inspect_image: "${input.path}" is not a readable regular file`);
      }
      if (info.size !== undefined && info.size > policy.maxImageBytes) {
        throw new Error(`inspect_image: "${input.path}" is ${info.size} bytes, exceeding maxImageBytes ${policy.maxImageBytes}`);
      }
      const data = await ctx.fs.readBytes(target, exec.signal, policy.maxImageBytes);
      const ref = await ctx.attachments.saveImage({
        data,
        mediaType: mediaTypeForPath(input.path),
        name: basename(input.path)
      });
      const answer = await askVision(ctx, get, ref, input.question ?? DEFAULT_QUESTION, exec.signal, exec.agent?.session.id, 'inspect_image');
      return { content: answer.text, path: input.path, ...(answer.truncated ? { truncated: true } : {}) };
    }
  }));
  const disposeDescribe = ctx.tools.register(dsh().tools.defineTool({
    name: 'describe_image',
    description: 'Get the content of an image attached to this chat as a text reference. The conversation contains a reference like [image: {...}]; pass the exact JSON inside it, and optionally a question or instruction to steer what the vision model should look for. Returns the selected vision model\'s answer as text, which becomes part of the conversation.',
    parameters: {
      ref: {
        type: 'string',
        required: true,
        description: 'The exact JSON from the [image: ...] reference in the conversation (attachmentId, mediaType, bytes, width, height).'
      },
      question: {
        type: 'string',
        description: 'Optional instruction steering what the vision model should describe or answer about the image. Defaults to a general detailed description.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          name: { type: 'string' },
          truncated: { type: 'boolean' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.truncated ? `${value.content ?? ''}\n\n[note: the vision model output was truncated at maxTokens]` : value.content ?? '' }],
      presentationMeta: (_args, value) => value
    },
    timeoutMs: get().tool.timeoutMs,
    async execute(args, exec) {
      const value = args as { ref?: unknown; question?: unknown } | null;
      if (value === null || typeof value !== 'object' || typeof value.ref !== 'string') {
        throw argsError(['describe_image: "ref" must be the exact JSON from the [image: ...] reference in the conversation']);
      }
      if (value.question !== undefined && typeof value.question !== 'string') {
        throw argsError(['describe_image: "question" must be a string when present']);
      }
      const ref = parseImageRef(value.ref);
      const stored = await ctx.attachments.readImage(ref, exec.signal);
      const answer = await askVision(
        ctx,
        get,
        ref,
        typeof value.question === 'string' && value.question.trim().length > 0 ? value.question.trim() : DEFAULT_QUESTION,
        exec.signal,
        exec.agent?.session.id,
        'describe_image',
      );
      return { content: answer.text, name: stored.ref.name ?? ref.attachmentId, ...(answer.truncated ? { truncated: true } : {}) };
    }
  }));

  return () => {
    disposeTool();
    disposeDescribe();
    disposePrompt();
  };
}
