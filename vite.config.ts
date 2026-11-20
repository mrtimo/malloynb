import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';

const ver = (pkg: string) =>
  JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8')).version;

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/; set BASE_PATH there.
  base: process.env.BASE_PATH ?? '/',
  define: {
    'process.env': {},
    __MALLOY_VERSION__: JSON.stringify(ver('@malloydata/malloy')),
    __DUCKDB_WASM_VERSION__: JSON.stringify(ver('@duckdb/duckdb-wasm')),
  },
  optimizeDeps: {
    exclude: ['@duckdb/node-api'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
  },
});
