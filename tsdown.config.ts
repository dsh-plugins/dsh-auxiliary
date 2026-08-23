/**
 * tsdown config for dsh-auxiliary — browser client bundle only. The node half
 * of the plugin (lib/index.js) is emitted by `tsc`; this config produces the
 * `window.__ModuleLoader__.load({id, factory})` closure-factory artifact the
 * GUI's client module system serves at `/plugins/@dsh-plugin/dsh-auxiliary/client.js`.
 *
 * Externals resolve through the loader module table (platform seed modules
 * plus the runtime/client exemption); everything else is inlined.
 */
import { defineConfig } from 'tsdown';

/** The module specifiers the web shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const;

/** Externals resolved from the loader module table (platform seeds + the documented runtime exemption). */
const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
  // dsh-loader 的 UI 套件（基础控件 + 策划图标）。必须是 external：它的产物是被
  // `window.__ModuleLoader__.load({ factory })` 包裹的 CJS 闭包，静态分析看不到任何
  // export，一旦被当成可内联依赖，rolldown 会报 MISSING_EXPORT。运行时由 DSH 客户端
  // 模块表解析（剥掉 /client 后缀 → 命中 dsh-loader 已注册的工厂 → 递归物化）。
  '@dsh-plugin/dsh-loader/client',
];

export default defineConfig({
  name: '@dsh-plugin/dsh-auxiliary/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-plugin/dsh-auxiliary", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
});
