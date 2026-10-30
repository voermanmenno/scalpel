// Writes test/harness-page.js with one wiki page for test/harness.html.
// Usage: node test/harness-page.mjs <page path substring> [wiki clone path]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , filter, wiki = process.env.SCALPEL_WIKI] = process.argv;
if (!filter || !wiki) throw new Error('Usage: node test/harness-page.mjs <page path substring> [wiki clone path] (or set SCALPEL_WIKI)');
const tree = execFileSync('git', ['-C', wiki, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 26 });
const line = tree.split('\n').find(l => l.endsWith('.md') && l.includes(filter));
if (!line) throw new Error(`no page matches ${filter}`);
const text = execFileSync('git', ['-C', wiki, 'cat-file', 'blob', line.split(' ')[2].split('\t')[0]], { encoding: 'utf8' });
writeFileSync(new URL('./harness-page.js', import.meta.url), `window.__page = ${JSON.stringify(text)};\n`);
console.log(`harness page: ${line.split('\t')[1]} (${text.length} chars)`);
