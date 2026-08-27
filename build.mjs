import { build } from 'esbuild'
import { cpSync } from 'node:fs'

const common = { bundle: true, sourcemap: false, logLevel: 'silent' }

await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
})

await build({
  ...common,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.js',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})

await build({
  ...common,
  entryPoints: ['src/renderer/app.ts'],
  outfile: 'dist/renderer/app.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
})

cpSync('src/renderer/index.html', 'dist/renderer/index.html')
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css')
cpSync('src/renderer/icon-drag.png', 'dist/renderer/icon-drag.png')

console.log('build complete → dist/')
