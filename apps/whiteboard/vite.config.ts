import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

// Built by `pnpm --filter @shst/tailcat-transport build:wasm`.
// Not committed; see packages/tailcat-transport/README.md.
const require = createRequire(import.meta.url);
const wasmDir = path.join(
  path.dirname(require.resolve('@shst/tailcat-transport/package.json')),
  'dist'
);
const wasmFiles = ['wasm_exec.js', 'main.wasm'];
const demoPort = Number(process.env.WHITEBOARD_DEMO_PORT ?? 5199);

/** Serve wasm_exec.js and main.wasm under /tailcat/, precompressed in dev. */
function tailcatAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tailcat-wasm-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/tailcat', (request, response, next) => {
        const [pathname = ''] = (request.url ?? '').split('?');
        const name = pathname.replace(/^\//, '');
        if (!wasmFiles.includes(name)) return next();
        const accepts = String(request.headers['accept-encoding'] ?? '');
        let file = path.join(wasmDir, name);
        if (name === 'main.wasm') {
          response.setHeader('Content-Type', 'application/wasm');
          response.setHeader('Vary', 'Accept-Encoding');
          if (accepts.includes('gzip') && existsSync(`${file}.gz`)) {
            response.setHeader('Content-Encoding', 'gzip');
            file = `${file}.gz`;
          }
        } else {
          response.setHeader('Content-Type', 'text/javascript');
        }
        if (!existsSync(file)) {
          response.statusCode = 404;
          response.end('Build the Tailcat wasm first; see packages/tailcat-transport/README.md.');
          return;
        }
        response.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(response);
      });
    },
    closeBundle() {
      // A static build carries the wasm when it has been built; without it the
      // page still loads and reports the missing runtime when you host or join.
      if (!wasmFiles.every((name) => existsSync(path.join(wasmDir, name)))) {
        this.warn('Tailcat wasm not built; the static build will not be able to connect.');
        return;
      }
      mkdirSync(path.join(outDir, 'tailcat'), { recursive: true });
      for (const name of wasmFiles)
        copyFileSync(path.join(wasmDir, name), path.join(outDir, 'tailcat', name));
    },
  };
}

export default defineConfig({
  plugins: [tailcatAssets()],
  server: { port: demoPort, strictPort: true, open: false },
  preview: { port: demoPort, strictPort: true },
});
