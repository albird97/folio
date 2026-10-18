/** Regenerates PLATFORM_CAPABILITIES.md from the capability matrix. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCapabilityMarkdown } from '../packages/platform-adapters/src/capabilities';

const target = join(import.meta.dirname, '..', 'PLATFORM_CAPABILITIES.md');
writeFileSync(target, renderCapabilityMarkdown());
console.log(`Wrote ${target}`);
