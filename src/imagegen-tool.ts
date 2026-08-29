/**
 * The model-facing `generate_image` tool: ask the configured auxiliary
 * image-generation model to produce images, save them under the session's
 * working directory, commit them through the attachment seam so they render
 * inline in the conversation, and return the file paths.
 *
 * The harness LLM seam only speaks text, so this tool talks to the provider's
 * OpenAI-compatible images API directly: the provider route's `baseURL` plus
 * the `apiKeyEnv` credential reference (read through the harness credential
 * seam) drive the request. Without a `reference` image the tool calls
 * `POST /images/generations` with a JSON body; with one it calls
 * `POST /images/edits` with a multipart form (img2img / image editing).
 * When the feature is disabled or incomplete the tool stays unregistered (the
 * model never sees it).
 *
 * @module dsh-auxiliary/imagegen-tool
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only side-effect imports: pull the `ctx.tools` / `ctx.credentials`
// Context augmentations; erased at compile time.
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-credentials';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { dsh, llm } from './dsh.js';
import { PLUGIN_ID, PLUGIN_NAME, type ResolvedPluginConfig } from './config.js';

/**
 * The llm-pi-ai settings namespace that owns the provider routes.
 *
 * A bare string rather than `settingsNamespace('llm-pi-ai')`: this is evaluated
 * at MODULE scope, before `apply` has injected the loader facade. dsh's
 * `settingsNamespace` is pure validation that returns its argument unchanged
 * (it only brands the string at the type level), so the literal plus the brand
 * cast is exactly equivalent.
 */
const LLM_PI_AI_NS = 'llm-pi-ai' as unknown as SettingsNamespace;

/** Default generated-image side; the OpenAI images API accepts this. */
const DEFAULT_SIZE = '1024x1024';

/** Naming the plugin in tool guidance. */
const TOOL_SECTION = 'tool:generate_image';

/** Accepted raster media types for a reference image. */
const EXTENSION_MEDIA: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Parse and validate the `generate_image` arguments. */
function parseArgs(args: Record<string, unknown>): {
  prompt: string;
  size: string;
  count: number;
  reference?: string;
} {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt.length === 0) {
    throw new Error('generate_image: "prompt" must be a non-empty string describing the image to generate');
  }
  const size = typeof args.size === 'string' && args.size.trim().length > 0 ? args.size.trim() : DEFAULT_SIZE;
  const rawCount = args.n === undefined ? 1 : args.n;
  const count = typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 1 ? rawCount : 1;
  const reference = typeof args.reference === 'string' && args.reference.trim().length > 0
    ? args.reference.trim()
    : undefined;
  return { prompt, size, count, reference };
}

/** Strip directory components from a file path for display. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Media type for a reference image path, or undefined for unsupported extensions. */
function referenceMediaType(path: string): string | undefined {
  const extension = (path.split('.').pop() ?? '').toLowerCase();
  return EXTENSION_MEDIA[extension];
}

/**
 * Register the `generate_image` tool plus system-prompt guidance.
 *
 * @returns a disposer that removes both registrations made by this function.
 */
export function registerImagegenTool(ctx: Context, get: () => ResolvedPluginConfig): () => void {
  const disposePrompt = ctx.systemPrompt.section({
    name: TOOL_SECTION,
    order: 165,
    text: 'Use the generate_image tool to create images with the configured auxiliary image-generation model when the user asks to generate, draw, or create a picture. Pass a detailed "prompt" describing the desired image. To edit or re-style an existing image (img2img), pass its path as "reference". The tool saves the generated images under the current working directory (.dsh/generated/) and displays them inline in the conversation; you can also inspect them with inspect_image to describe or verify them.'
  });
  const disposeTool = ctx.tools.register(dsh().tools.defineTool({
    name: 'generate_image',
    description: 'Generate images with the configured auxiliary image-generation model (OpenAI-compatible images API). Pass a detailed prompt; images are displayed inline and saved under the working directory.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Detailed description of the image to generate.'
      },
      size: {
        type: 'string',
        description: 'Requested size, e.g. 1024x1024, 1792x1024, or 1024x1792. Defaults to 1024x1024.'
      },
      n: {
        type: 'number',
        description: 'How many images to generate (most providers accept only 1). Defaults to 1.'
      },
      reference: {
        type: 'string',
        description: 'Optional absolute or workspace-relative path of a reference image to edit or re-style (img2img, sent to the images/edits endpoint).'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                name: { type: 'string' }
              }
            }
          }
        }
      },
      render: (_args, value) => [
        { type: 'text', text: value.content ?? '' },
        ...(Array.isArray(value.images)
          ? value.images.map((ref) => ({ type: 'image' as const, attachment: ref as unknown as ImageAttachmentRef }))
          : []),
      ],
      presentationMeta: (_args, value) => value
    },
    timeoutMs: 600000,
    async execute(args, exec) {
      const input = parseArgs(args);
      const imagegen = get().imagegen;
      if (!imagegen.enabled || imagegen.provider === undefined || imagegen.model === undefined) {
        throw new Error(
          'generate_image: the auxiliary image-generation model is not configured — enable it under Settings → Auxiliary Models → Image-generation model and pick a model marked for image generation',
        );
      }
      const namespace = ctx.settings.get(LLM_PI_AI_NS) as
        { providers?: Record<string, { baseURL?: string; apiKeyEnv?: string }> } | undefined;
      const provider = namespace?.providers?.[imagegen.provider];
      const baseURL = provider?.baseURL;
      // apiKeyEnv is a credential reference; resolve it through the harness
      // credential seam (env / file / user-env layers), never process.env.
      let apiKey: string | undefined;
      const ref = provider?.apiKeyEnv;
      if (ref !== undefined && ref.length > 0) {
        const resolved = await ctx.credentials.resolve(dsh().credentials.credentialRef(ref));
        apiKey = resolved?.value;
      }
      if (baseURL === undefined || baseURL.length === 0 || apiKey === undefined) {
        throw new Error(
          `generate_image: provider "${imagegen.provider}" is missing a baseURL or its API key is not configured (${ref ?? 'no apiKeyEnv'})`,
        );
      }

      // Load the reference image first so argument errors surface before any
      // provider request.
      let referenceBytes: Uint8Array | undefined;
      let referenceMedia: string | undefined;
      let referenceName: string | undefined;
      if (input.reference !== undefined) {
        const cwd = exec.agent?.session.header.cwd;
        const target = await ctx.fs.resolve(input.reference, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal,
        });
        const info = await ctx.fs.stat(target, exec.signal);
        if (info === undefined || info.type !== 'file') {
          throw new Error(`generate_image: reference "${input.reference}" is not a readable regular file`);
        }
        const media = referenceMediaType(target.displayPath);
        if (media === undefined) {
          throw new Error('generate_image: reference image must be PNG, JPEG, or WebP');
        }
        referenceBytes = await ctx.fs.readBytes(target, exec.signal, 16 * 1024 * 1024);
        referenceMedia = media;
        referenceName = basename(target.displayPath);
      }

      const root = `${baseURL.replace(/\/+$/, '')}`;
      const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
      let body: BodyInit;
      if (referenceBytes !== undefined) {
        // Image editing / img2img: multipart form to /images/edits.
        const form = new FormData();
        form.append('model', imagegen.model);
        form.append('prompt', input.prompt);
        form.append('size', input.size);
        form.append('n', String(input.count));
        form.append('image', new Blob([referenceBytes as unknown as BlobPart], { type: referenceMedia }), referenceName);
        body = form;
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({
          model: imagegen.model,
          prompt: input.prompt,
          size: input.size,
          n: input.count,
        });
      }
      const response = await fetch(`${root}/${referenceBytes !== undefined ? 'images/edits' : 'images/generations'}`, {
        method: 'POST',
        headers,
        body,
        signal: exec.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`generate_image: provider returned ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 400)}` : ''}`);
      }
      const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
      const items = payload.data ?? [];
      if (items.length === 0) {
        throw new Error('generate_image: the provider returned no images');
      }
      const cwd = exec.agent?.session.header.cwd;
      const dir = join(cwd ?? '.', '.dsh', 'generated');
      await mkdir(dir, { recursive: true });
      const paths: string[] = [];
      const images: ImageAttachmentRef[] = [];
      const stamp = Date.now();
      for (const [index, item] of items.entries()) {
        let buffer: Buffer;
        if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
          buffer = Buffer.from(item.b64_json, 'base64');
        } else if (typeof item.url === 'string' && item.url.length > 0) {
          const imageResponse = await fetch(item.url, { signal: exec.signal });
          if (!imageResponse.ok) continue;
          buffer = Buffer.from(await imageResponse.arrayBuffer());
        } else {
          continue;
        }
        const file = join(dir, `${PLUGIN_ID}-${stamp}-${index + 1}.png`);
        await writeFile(file, buffer);
        paths.push(file);
        const attachment = await ctx.attachments.saveImage({
          data: new Uint8Array(buffer),
          mediaType: 'image/png',
          name: basename(file),
        });
        images.push(attachment);
      }
      if (paths.length === 0) {
        throw new Error('generate_image: none of the provider responses contained a decodable image');
      }
      // Commit the images into the conversation as a user message so they
      // render inline in the chat, exactly like the core read_image tool does.
      // The tool output itself carries the image blocks too, but only a
      // deferred context message enters durable session history.
      if (exec.parent !== void 0) exec.deferContext(llm().createUserMessage({
        content: [
          { type: 'text', text: `Generated ${paths.length} image(s):\n${paths.map((path) => `- ${path}`).join('\n')}` },
          ...images.map((ref) => ({ type: 'image' as const, attachment: ref as unknown as ImageAttachmentRef })),
        ],
        source: { kind: 'plugin', plugin: PLUGIN_NAME },
      }));
      return {
        content: `Generated ${paths.length} image(s):\n${paths.map((path) => `- ${path}`).join('\n')}`,
        paths,
        images,
      };
    },
  }));

  return () => {
    disposePrompt();
    disposeTool();
  };
}
