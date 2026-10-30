/** Adapter for the published 0.2.1/0.2.2 translator's fixed official-API model.
 * Keep its admission, storage, audit, stream validation and cancellation intact.
 * The legacy Flash placeholder is mapped only inside one translator invocation.
 */
import type { PatchAPI, PatchHandle } from '@dsh-plugin/dsh-loader/patch';

interface TranslationSpec { provider: string; [key: string]: unknown }
interface Translator {
  ctx: { get(name: string): any; [key: string]: any };
  storage: { run(session: string, identity: Record<string, unknown>, ...args: any[]): any };
  translate(spec: TranslationSpec, signal?: AbortSignal): Promise<string>;
  availableProviders(signal?: AbortSignal): Promise<string[]>;
}
export function installOfficialTranslationModel(
  input: unknown,
  patch: PatchAPI,
  get: () => { enabled: boolean; model: string },
): () => void {
  const translator = ((input as Record<symbol, unknown>)?.[Symbol.for('cordis.original')] ?? input) as Translator;
  if (!translator?.ctx || typeof translator.ctx.get !== 'function' || typeof translator.storage?.run !== 'function'
    || typeof translator.translate !== 'function' || typeof translator.availableProviders !== 'function') {
    throw new Error('dsh-auxiliary: unsupported official translator contract');
  }
  const lifetime = new AbortController();
  const signalFor = (signal?: AbortSignal) => AbortSignal.any(signal ? [signal, lifetime.signal] : [lifetime.signal]);
  const selected = () => { const value = get(); return value.enabled && value.model !== 'deepseek-flash' ? value.model : undefined; };
  const view = (service: Translator, model: string): Translator => {
    const ctx = service.ctx, llm = ctx.get('llm');
    // Every other service/provider and all credential ownership checks remain native.
    const adaptedLlm = llm && new Proxy(llm, { get(target, key) {
      if (key === 'listModels') return async (provider: string, ...args: any[]) => {
        const rows = await target.listModels(provider, ...args);
        if (provider !== 'deepseek-official') return rows;
        return rows.filter((row: { id: string }) => row.id === model)
          .map((row: object) => ({ ...row, id: 'deepseek-flash' }));
      };
      if (key === 'prepareCall') return (config: Record<string, unknown>, signal?: AbortSignal) => {
        if (config.provider === 'deepseek-official' && config.model === 'deepseek-flash') {
          return target.prepareCall({ ...config, model }, signal);
        }
        return target.prepareCall(config, signal);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const adaptedContext = new Proxy(ctx, { get(target, key) {
      if (key === 'get') return (name: string) => name === 'llm' ? adaptedLlm : target.get(name);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const storage = service.storage;
    const adaptedStorage = new Proxy(storage, { get(target, key) {
      if (key === 'run') return (session: string, identity: Record<string, unknown>, signal: AbortSignal, operation: (log: any) => any) => {
        const rewrite = (value: Record<string, unknown>) => ({ ...value, recipe: value.provider === 'deepseek-official'
          ? JSON.stringify(['dsh-auxiliary:official-translation:v1', model, value.recipe]) : value.recipe });
        return target.run(session, rewrite(identity), signal, (log: any) => operation({
          ...log, request: (data: Record<string, unknown>) => log.request(rewrite(data)),
        }));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return new Proxy(service, { get(target, key) {
      if (key === 'ctx') return adaptedContext;
      if (key === 'storage') return adaptedStorage;
      return Reflect.get(target, key, target);
    } });
  };
  const translate = patch.method(translator, 'translate', original => function(this: Translator, spec, signal) {
    const model = selected();
    if (!model || spec.provider !== 'deepseek-official') return original.call(this, spec, signal);
    return original.call(view(this, model), spec, signalFor(signal));
  }, { id: 'dsh-auxiliary:translation-model' });
  let available: PatchHandle;
  try { available = patch.method(translator, 'availableProviders', original => function(this: Translator, signal) {
    const model = selected();
    return model ? original.call(view(this, model), signalFor(signal)) : original.call(this, signal);
  }, { id: 'dsh-auxiliary:translation-availability' });
  } catch (error) { translate.dispose(); lifetime.abort(error); throw error; }
  return () => {
    lifetime.abort(new Error('dsh-auxiliary translation model override unloaded'));
    available.dispose(); translate.dispose();
  };
}
