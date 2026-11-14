// This entry must remain independent of dsh-loader and of the main plugin imports.
import { createRequire } from 'node:module';

export const name = '@dsh-plugin/dsh-auxiliary/loader-check';
export const inject = [];
export const message = '[@dsh-plugin/dsh-auxiliary] 请安装并启用 @dsh-plugin/dsh-loader 的最新发布版（@latest）或预发布版（@next）。'
  + ' Install and enable the latest release or prerelease of @dsh-plugin/dsh-loader: '
  + 'dsh plugin add @dsh-plugin/dsh-loader@latest / dsh plugin add @dsh-plugin/dsh-loader@next';

export function apply(ctx) {
  if (ctx.get('dshLoader')) return;
  const warn = () => {
    if (ctx.get('dshLoader')) return;
    if (ctx.logger?.warn) ctx.logger.warn(message);
    // Host logger sinks may be file-only; also make the actionable hint visible at startup.
    console.warn(message);
  };
  try {
    createRequire(import.meta.url).resolve('@dsh-plugin/dsh-loader');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    warn();
    return;
  }
  // npm may have installed the peer without activating its bundle. Let the
  // loader start first; this optional check never holds up host activation.
  ctx.effect(() => {
    const timer = setTimeout(warn, 5000);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
}
