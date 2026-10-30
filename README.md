<div align="center">

![Banner](./docs/banner.png)

# dsh-auxiliary

**Auxiliary models for DeepSeek Harness — dedicated model routes, tools, and system guidance for vision, compaction, reviews, subagents, titles, and image generation, without touching the main conversation model.**

English | [简体中文](README.zh_CN.md)

[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f7cff)](https://github.com/topics/dsh-plugin)
<a href="https://github.com/dsh-plugins/dsh-auxiliary/actions/workflows/npm-publish.yml">
  <img src="https://github.com/dsh-plugins/dsh-auxiliary/actions/workflows/npm-publish.yml/badge.svg" alt="Build Status">
</a>
<a href="https://www.npmjs.com/package/@dsh-plugin/dsh-auxiliary">
  <img src="https://img.shields.io/npm/v/@dsh-plugin/dsh-auxiliary.svg?sanitize=true" alt="Version">
</a>
<a href="https://www.npmjs.com/package/@dsh-plugin/dsh-auxiliary">
  <img src="https://img.shields.io/npm/l/@dsh-plugin/dsh-auxiliary.svg?sanitize=true" alt="License">
</a>

</div>

`dsh-auxiliary` is a [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) plugin that layers auxiliary-model capabilities on the harness LLM seam (`ctx.llm`). It never replaces the main conversation model: each feature is an independent, optional route that kicks in only for its own narrow call category, so you can give expensive or specialized work (vision, compaction summaries, approval reviews, delegated subagents, session titles, image generation) its own cheap or capable model.

## Feature overview

| Feature | What it does | Where to configure |
| --- | --- | --- |
| Vision understanding | `inspect_image` tool: read a local image and ask a vision model about it | Plugin configuration → **Vision understanding** |
| Image handoff | Chat images survive a text-only main model via `describe_image` | Vision understanding card → **Image handoff** |
| Context compaction | Summaries (`purpose: 'compaction'`) use a dedicated model | Plugin configuration → **Context compaction** |
| Compression engine *(optional)* | Replaces the compaction backend with an explicit compression prompt | `engine.enabled` in the config |
| Approval model | Reviews from @dsh-plugin/dsh-approve-for-me use a dedicated model | Plugin configuration → **Approval model** |
| Subagent model | Delegated child agents use a dedicated model | Plugin configuration → **Subagent model** |
| Title model | Session titles (`purpose: 'session-title'`) use a dedicated model | Plugin configuration → **Title model** |
| Image-generation model | `generate_image` tool: create images through an OpenAI-compatible images API | Plugin configuration → **Image-generation model** |
| Model capability marks | Checkboxes on your own `llm-pi-ai` models: version-gated **Allow image input** / **Allow image generation** | Models page → provider → customized settings → model |

All routes are configured in **the loader-managed plugin configuration** (rendered by loader) and take effect immediately on save — no restart, no rebuild of the conversation.

## Installation

Copy the block below and paste it to your DSH agent (the assistant in this web
GUI). The agent performs the install and verification for you — no manual npm
or profile editing needed:

```text
Install the @dsh-plugin/dsh-auxiliary plugin into the profile I specify (or ask me if I didn't name one). The npm package name is `@dsh-plugin/dsh-auxiliary`; use the GitHub source `github:dsh-plugins/dsh-auxiliary`, or `file:<path>` for local development.

Steps:
1. Add the plugin dependency: `dsh plugin --profile <PROFILE> add @dsh-plugin/dsh-auxiliary` (or the equivalent plugin-manager command for my profile). Since 0.4.1 the package is a bundle plugin (declares `dsh.bundle.patch`), so `dsh plugin add` also appends it to `dsh.profile.bundles` automatically — no manual `cordis.patch.yml` insert needed.
2. The package declares a `prepack` build script. If pnpm fails with `ERR_PNPM_IGNORED_BUILDS`, approve the build in the profile's `pnpm-workspace.yaml` (`allowBuilds`) and retry the add.
3. If this profile previously loaded the plugin through a manual insert row in `cordis.patch.yml` (pre-0.4.1 style), REMOVE that row — the bundle layer now mounts the plugin, and keeping both would mount it twice.
4. Verify `node_modules/@dsh-plugin/dsh-auxiliary` holds a built `lib/` directory (at least `lib/index.js` and `lib/client.js`). If the build artifacts are missing, run `npm run build` in the plugin directory and re-add.
5. Do not start the profile — install and verify only, then report what you changed.
```

Then open **the loader-managed plugin configuration** in the web UI to configure the
routes, and mark the models you want to use in **Settings → Models**.

## Features in detail

### Vision understanding and `inspect_image`

Configure a provider/model in the **Models** page first, then pick the pair under **Vision understanding** (saved as `vision.provider` + `vision.model`). `tool.enabled` independently controls whether the `inspect_image` tool is registered.

```yaml
vision:
  provider: anvilcraft-ai     # any registered provider route
  model: mimo-v2.5            # a vision-capable model on that provider
tool:
  enabled: true               # register the inspect_image tool
  maxImageBytes: 10485760     # per-file size cap
  timeoutMs: 120000           # cooperative tool-call budget
```

Once enabled, ask the agent to run `inspect_image` on a Host-readable path:

> Use inspect_image to analyze screenshots/error.png

The tool commits the file through the `ctx.attachments` seam and asks the selected vision model, returning a text answer (optionally truncated at `vision.maxTokens`). PNG, JPEG, WebP, and GIF are supported.

**Model capability mark**: for a user-configured `llm-pi-ai` model, the **Allow image input** checkbox in the model's settings writes its canonical `input` declaration (`[text, image]` when checked, `[text]` when cleared). Both `inspect_image` and the main chat composer read that same capability fact. The declaration cannot add vision to a text-only model — only check it when the upstream endpoint actually accepts images.

### Image handoff (chat images with a text-only main model)

When **Image handoff** (`vision.handoff`, default on) is enabled with a vision route selected, image delivery is native-first and falls back safely for routes without declared image support:

1. A runtime wrapper on `ctx.llm.resolveModelInfo` claims image input for text-only main routes while handoff is active, so the image admission preflight passes (the model catalog and per-model checkboxes are unaffected because they read the settings document directly). The configured auxiliary vision route is never inflated, so `inspect_image`/`describe_image` still reject a mistakenly selected text-only vision model.
2. For each request containing images, a listener on the official `llm/stream` waterfall checks the exact request's provider/model through the original capability resolver. Image-capable routes receive the original `ImageBlock`s unchanged. Text-only routes and routes with undeclared modalities receive durable text references such as `[image: {"attachmentId":…,"mediaType":…}]`; nested images in tool results are rewritten too.
3. The system prompt tells a text-only main model to call `describe_image` with the exact JSON from the reference; the tool reads the stored attachment bytes, asks the selected vision model, and returns a text description.

The rewrite is immutable and request-local, so concurrent native and fallback streams cannot affect one another; aborts, errors, early iterator closure, and plugin disposal retain the host stream semantics. References are plain text and therefore survive restarts, forks, and replays. Both seams are plugin-side; no core package is modified. Disable `vision.handoff` to restore the original admission and stream behavior.

### Skipping injection for vision-capable main models

When **Skip when the main model supports images** (`vision.skipWhenMainModelSupportsImage`, default off) is enabled, a session whose main model declares image input gets no `inspect_image`/`describe_image` tool schemas and no vision prompt section — the model reads attached images natively. This existing option uses the public generic prompt-assembly context and the host's original `resolveModelInfo` (captured before the handoff wrapper); the tools stay registered, so an in-flight or replayed call still executes.

This is intentionally separate from image handoff's exact `llm/stream` route check. Exact per-attempt **Auto / Always / Disabled** tool and prompt visibility would require Harness core to publish the prepared request route/capabilities to prompt assembly together with a request-lifetime tool restriction contract. That contract is not part of the released public API, so this plugin-only change does not add a dead setting or depend on private agent-loop types.

The released `llm/stream` contract also describes agent-loop request content as read-only. This release therefore keeps the plugin's pre-existing compatibility shim but makes it capability-aware and concurrency-safe; a fully first-class handoff should follow with a core-owned, session-logged image-reference projection/admission hook so plugins do not have to redispatch rewritten loop requests.

### Context compaction

Every summarization call carries the official `GenerateOptions.purpose: 'compaction'`. The plugin installs an `llm/stream` waterfall listener that reroutes those calls to the configured pair:

```yaml
compact:
  enabled: true
  provider: deepseek-official  # e.g. a cheap, fast summarizer
  model: deepseek-chat
```

The listener is always installed and is a pure pass-through until a complete route is configured. Only `purpose: 'compaction'` calls are rerouted; the main session and every other call category are untouched.

**Compression engine** *(optional)*: `engine.enabled: true` replaces the stock compaction backend with a `BasicCompactionEngine` subclass that drives summarization with an explicit context-compression instruction (see `engine.compressPrompt`). It reuses the compact route and adds no third model route. It is mutually exclusive with `@deepseek-ai/dsh-compaction-basic` — the plugin detects the conflict and skips the engine with a warning.

**Compaction threshold**: set `engine.enabled` and `engine.thresholdRatio` in the unified form, so compaction fires automatically once context usage reaches that percentage; the threshold must stay above the retention ratio (`engine.retainRatio`, 16% by default). The engine refreshes the policy before every pressure check, so no restart is needed after saving.

### Automatic review model

Before `0.1.7-rc.2`, `approve` routes approve-for-me review calls. From that release, it routes official `@deepseek-ai/dsh-experimental-auto-review` calls. Only provider/model are replaced; official policy, inputs, Session attribution, cancellation and decisions remain native. Enable the official plugin and choose its Auto permission mode separately.

```yaml
approve:
  enabled: true
  provider: my-provider
  model: my-review-model
```

### Reasoning machine-translation model

From `0.2.1-rc.1`, the unified form includes a reasoning translation group:

```yaml
translation:
  enabled: true
  model: deepseek-flash  # an existing model ID in the native official-API catalog
```

Enable `@deepseek-ai/dsh-experimental-cot-translation-bundle` and select **DeepSeek Flash · Official API** in its translation menu. This setting changes that service's model, keeping the `deepseek-official` provider. Bing, Google and Account translation keep their original behavior.

Native credential/model/owner checks, thinking-off requests, deadlines, cancellation, response validation and Session storage are retained. Disabled overrides use native Flash. Selected models have distinct cache identities and truthful audit metadata. Configure official API credentials separately; inference uses the selected model's normal billing. Unloading releases patches and cancels active override requests.

### Subagent model

```yaml
subagent:
  enabled: true
  provider: anvilcraft-ai
  model: deepseek-chat
```

Child agents inherit their parent's route by default. With this feature enabled and a complete route, every delegated child — one-shot spawn/fork runs and continuable children, including cold-resumed ones — is routed to the selected pair. The plugin listens for `agent/created` and, for agents with delegation depth > 0, installs an `agent/request` waterfall listener on the agent's own scoped context; returning a replacement `LlmCallConfig` is the loop's official "switch" contract, so the changed header snapshot is logged like any other model switch. Remote providers (ACP) never register a process-local agent and their children keep inheriting the parent route. Prefer a cheap, fast model to control delegation cost. No external plugin required.

### Title model

```yaml
title:
  enabled: true
  provider: anvilcraft-ai
  model: deepseek-chat
```

Session titles are issued by the `dsh-session-title-llm` provider, which has its own deployment-level `provider`/`model` config. With this feature enabled, every `purpose: 'session-title'` call is rerouted to the selected pair, leaving the provider's own config and the main session route untouched. Recognition uses the official `GenerateOptions.purpose` marker, so it cannot collide with agent-loop, compaction, or approval calls. Like the compaction router, the listener is always installed and passes through until a complete route is configured.

### Image-generation model and `generate_image`

```yaml
imagegen:
  enabled: true
  provider: lanqin-gpt          # an OpenAI-compatible provider route
  model: gpt-image-2
```

The harness LLM seam only speaks text, so image generation talks to the provider's OpenAI-compatible **images API** directly. With this feature enabled and a complete route:

1. The `generate_image` tool is registered and a system-prompt section tells the main model to call it when the user asks to generate, draw, or create a picture.
2. The tool reads the provider's `baseURL` from the resolved `llm-pi-ai` settings and resolves `apiKeyEnv` through the harness **credential seam** (`ctx.credentials.resolve` — env/file/user-env layers), then calls `POST {baseURL}/images/generations` with `{model, prompt, size, n}`.
3. The returned images (base64 or URL) are written under the working directory (`.dsh/generated/`) and the file paths are returned; the main model can verify them with `inspect_image`.

**Model capability mark**: use a model that supports image generation; the optional **Allow image generation** checkbox in model settings writes `imageGeneration: true` into the raw user section of the `llm-pi-ai` namespace. Mark exactly the models whose upstream endpoint actually generates images.

## How it works

The plugin consumes dsh-loader 2.x facades. Config-api owns the form and persistence; model editor enhancements follow the host version in the loader boot description. Feature registrations are reconciled against each updated configuration snapshot.

### 1. Purpose-keyed model routing

All text routing shares one pattern: install an `llm/stream` waterfall listener **once** (always active), inspect the call, and either pass it through untouched or re-enter the seam with a frozen replacement config:

- **Recognition** uses stable, official markers — `GenerateOptions.purpose` (`'compaction'` / `'session-title'`) or the approval call's public contract — so each router can only ever match its own call category.
- **Rerouting** calls `deepFreeze({...options, provider, model})` and re-enters `ctx.llm.stream()`; the `provider`/`model` replacement is the only change, so timeouts, retries, and fallback stay harness-owned.
- **Loop protection**: the replacement carries the same route marker; an equality check on the config prevents the router from matching its own re-entry.
- **Laziness**: the listener is a pure pass-through until a complete route exists — enabling the feature later needs no reinstall, and disabling it needs no cleanup beyond removing the listener.

### 2. Tools and system guidance

Tools are registered with `ctx.tools.register(defineTool(...))` and announced to the model through `ctx.systemPrompt.section(...)`:

- `inspect_image` — vision understanding: file path + optional question → attachment seam → vision route → text answer.
- `describe_image` — handoff: reads the JSON from a chat `[image: …]` reference and answers via the vision route.
- `generate_image` — image generation: prompt (+size/n) → provider images API (credential seam) → PNG files under `.dsh/generated/` → paths.

Each tool is registered only while its feature is enabled with a complete route (reconcile pattern), so the model never sees a tool it cannot use.

### 3. Configuration and the model catalog

Plugin preferences use config-api independently of host settings and `exposeAllNamespaces`. Model enhancements edit the official `llm-pi-ai` data through the loader-normalized connection API. Once the official editors take over, the plugin removes those controls and stops inherited/deferred writes for their fields. Image generation declarations remain available.

### 4. Credentials, not plain env

`apiKeyEnv` values are `credential-ref`s, so the image-generation tool resolves the key through `ctx.credentials.resolve(credentialRef(...))` — the harness credential seam covers env/file/user-env layers and re-resolves per call (a changed key reaches the next call without a restart). Never `process.env`.

### 5. Everything reconfigures live

Each feature is owned by a `reconcile*()` + disposer pair: on every settings change the plugin re-resolves the config and registers or disposes exactly the pieces whose conditions changed. Saving a route in the web UI takes effect immediately.

## Configuration

The Cordis row below can seed initial defaults. Subsequent changes use config-api; an existing config file takes precedence.

```yaml
- name: '@dsh-plugin/dsh-auxiliary'
  config:
    vision:
      maxTokens: 2048                      # inspect_image output cap (provider/model written by the settings page)
      handoff: true                        # text-only main models may reference chat images via describe_image
      skipWhenMainModelSupportsImage: false # image-capable main models get no vision tools/prompt injected
    tool:
      enabled: true                        # register the inspect_image tool
      maxImageBytes: 10485760              # per-file size cap
      timeoutMs: 120000                    # cooperative tool-call budget
    compact:
      enabled: false                       # reroute compaction summaries to an auxiliary model
      provider: ""                         # e.g. deepseek-official (a registered provider route id)
      model: ""                            # e.g. deepseek-chat (a model id on that provider)
    approve:
      enabled: false                       # give @dsh-plugin/dsh-approve-for-me's reviews a dedicated model
      provider: ""                         # e.g. deepseek-official (a registered provider route id)
      model: ""                            # e.g. deepseek-chat (a model id on that provider)
    subagent:
      enabled: false                       # route delegated subagents to a dedicated model
      provider: ""                         # e.g. deepseek-official
      model: ""                            # e.g. deepseek-chat
    title:
      enabled: false                       # route session-title calls to a dedicated model
      provider: ""                         # e.g. deepseek-official
      model: ""                            # e.g. deepseek-chat
    imagegen:
      enabled: false                       # register generate_image with a dedicated image model
      provider: ""                         # e.g. lanqin-gpt (an OpenAI-compatible provider route)
      model: ""                            # e.g. gpt-image-2 (marked Allow image generation)
    engine:
      enabled: false                       # optional compression engine (mutually exclusive with dsh-compaction-basic)
      thresholdRatio: 0.8
      retainRatio: 0.16
      maxTokens: 8192
      compactionRetries: 1
      maxOverflowRetries: 1
      auto: true
      compressPrompt: "..."                # custom compression instruction
```

### Unified form and 1.x migration

Requires Node.js 24.9+ and dsh-loader 2.x. Supports its six explicit release families: `0.1.5`, `0.1.6`, `0.1.7`, `0.2.0`, `0.2.1`, `0.2.2`, including prereleases. Before `0.1.6-alpha.2`, use **Settings → Plugin configuration**; from that release, use the plugin detail page.

One collapsed plugin card groups vision, compaction, approval, subagent, title, image generation and compression engine settings. Enter provider/model route IDs already configured in the official Models page. Saved changes apply to subsequent requests; hidden fields keep their values.

Preferences live at `<profile>/config/dsh-auxiliary/config.json`. The old 1.x `dsh-auxiliary` settings namespace is not automatically imported: copy values manually. Cordis row configuration seeds defaults on first registration; an existing file takes precedence. Manual edits require a plugin reload or restart.

Set provider/model pairs together and keep `engine.retainRatio` below `engine.thresholdRatio`. Config-api checks field ranges; runtime cross-field validation reports errors and keeps the last valid running configuration.

### Model editor version boundaries

| dsh version | Plugin input editor | Plugin reasoning editor | Image generation flag |
| --- | --- | --- | --- |
| `< 0.1.7-rc.1` | Enabled | Enabled | Enabled |
| `>= 0.1.7-rc.1`, `< 0.2.1-rc.1` | Official UI | Enabled | Enabled |
| `>= 0.2.1-rc.1` | Official UI | Official UI | Enabled |

The named releases are included in each cutoff. Legacy controls live in the model capacity disclosure. Changes wait for the official provider save to finish. Renaming only inherits fields still owned by the plugin for that version. Unload stops observation and deferred writes, removes controls and unmounts React roots.

## Notes

- Routing features reroute only their own call category (`purpose:
  'compaction'` / `purpose: 'session-title'` / the approval review contract);
  the main session route is never touched.
- `engine.enabled: true` **replaces** the stock compaction backend; do not load
  `@deepseek-ai/dsh-compaction-basic` at the same time. The plugin detects the
  conflict and skips the engine with a warning.
- Vision tool arguments: `path` (absolute or workspace-relative) and optional
  `question`. Supported formats: PNG, JPEG, WebP, GIF.
- `generate_image` arguments: `prompt` (required), optional `size` and `n`
  (most providers accept only `n: 1`).

## Development

```bash
npm install          # installs dependencies (typescript, @deepseek-ai/* peers)
npm run typecheck    # tsc --noEmit
npm test             # builds and runs the Node regression tests
npm run build        # emits lib/
```

## License

[LGPL-3.0](LICENSE)
