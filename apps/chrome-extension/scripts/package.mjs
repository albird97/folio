/**
 * Zips dist/ for upload to the Chrome Web Store:
 *   pnpm --filter @folio/chrome-extension package
 * Requires the `zip` command (preinstalled on macOS and Linux CI images).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8'));
const target = join(root, `folio-chrome-${version}.zip`);
rmSync(target, { force: true });
execFileSync('zip', ['-r', '-X', '-q', target, '.'], { cwd: join(root, 'dist'), stdio: 'inherit' });
console.log(`Packaged ${target}`);
