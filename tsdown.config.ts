import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-astudio-connect'

/**
 * Modules the host loader provides, kept out of the plugin bundle. The DSH
 * runtime resolves these from the profile's shared node_modules; bundling them
 * would duplicate host modules and bloat the bundle.
 */
const HOST_EXTERNALS = [
  '@earendil-works/pi-ai',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
] as const

/**
 * The client's only runtime dependency. Its DSH imports are type-only today,
 * so they erase at build time; React stays external for the web client.
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime'] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
