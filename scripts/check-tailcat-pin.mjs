// Fails when a Go module's sbktio/tailcat pin and the package/tailcat
// submodule name different commits. The modules build from the pin, which go.sum
// verifies; the submodule is the source people read and test. They must agree.
//
//   node scripts/check-tailcat-pin.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const modules = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps/**/go.mod', 'packages/**/go.mod'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file && /github\.com\/tailscale\/tailcat /.test(readFileSync(file, 'utf8')));
const pinPattern =
  /^replace github\.com\/tailscale\/tailcat => github\.com\/sbktio\/tailcat v0\.0\.0-\d{14}-([0-9a-f]{12})$/m;

const gitlink = execFileSync('git', ['ls-files', '--stage', '--', 'package/tailcat'], {
  encoding: 'utf8',
}).split(/\s+/)[1];
if (!gitlink) {
  console.error('package/tailcat is not a submodule in the index');
  process.exit(1);
}

if (modules.length === 0) {
  console.error('no Go module requires github.com/tailscale/tailcat');
  process.exit(1);
}
let failed = false;
for (const file of modules) {
  const pin = readFileSync(file, 'utf8').match(pinPattern)?.[1];
  if (!pin) {
    console.error(`${file}: no "replace github.com/tailscale/tailcat => github.com/sbktio/tailcat v0.0.0-…" pin`);
    failed = true;
  } else if (!gitlink.startsWith(pin)) {
    console.error(`${file}: pins sbktio/tailcat ${pin}, but package/tailcat is at ${gitlink.slice(0, 12)}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`tailcat pin matches package/tailcat (${gitlink.slice(0, 12)}) in ${modules.join(', ')}`);
