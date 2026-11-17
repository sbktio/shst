// Builds the qbtailcat browser wasm (./cmd/wasm), plus Go's wasm_exec.js and a
// gzip copy for the dev server.
// Output goes to packages/tailcat-transport/dist, which is git-ignored.
// Requires Go 1.27+.
//
//   pnpm --filter @shst/tailcat-transport build:wasm
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(here, '../qbtailcat');
const out = path.resolve(here, '../dist');
mkdirSync(out, { recursive: true });

const go = (args, env = {}) =>
  execFileSync('go', args, {
    cwd: moduleDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const tags = go(['run', './cmd/wasmtags']).trim();
go(
  [
    'build',
    '-tags',
    tags,
    '-ldflags=-s -w',
    '-o',
    path.join(out, 'main.wasm'),
    './cmd/wasm',
  ],
  {
    GOOS: 'js',
    GOARCH: 'wasm',
  }
);
const goroot = go(['env', 'GOROOT']).trim();
copyFileSync(
  path.join(goroot, 'lib', 'wasm', 'wasm_exec.js'),
  path.join(out, 'wasm_exec.js')
);
const wasm = readFileSync(path.join(out, 'main.wasm'));
writeFileSync(path.join(out, 'main.wasm.gz'), gzipSync(wasm, { level: 9 }));

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
process.stdout.write(
  `built ${out}: main.wasm ${mb(wasm.length)} (gzip ${mb(gzipSync(wasm, { level: 9 }).length)})\n`
);
