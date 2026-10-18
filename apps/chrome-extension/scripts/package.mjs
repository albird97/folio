/**
 * Zips dist/ for upload to the Chrome Web Store:
 *   pnpm --filter @folio/chrome-extension package
 * Requires the `zip` command (preinstalled on macOS and Linux CI images).
 *
 * The package leaves out the manifest's `key`: it only pins the extension ID
 * for unpacked development builds, and the Web Store assigns its own ID.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8'));
const target = join(root, `folio-chrome-${version}.zip`);
rmSync(target, { force: true });

const staging = mkdtempSync(join(tmpdir(), 'folio-extension-'));
try {
  cpSync(join(root, 'dist'), staging, { recursive: true });
  const manifestPath = join(staging, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.key;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync('zip', ['-r', '-X', '-q', target, '.'], { cwd: staging, stdio: 'inherit' });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`Packaged ${target} (without the development key)`);
