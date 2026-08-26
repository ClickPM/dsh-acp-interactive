import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts', 'src/bin.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: { sourcemap: false },
  clean: true,
  // The host process owns DeepSeek Harness singletons.
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
