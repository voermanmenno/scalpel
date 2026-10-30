// Writes test/harness-page.js with every '::: mermaid' block of the wiki, one per section,
// to check in test/harness.html which diagrams render. Usage: node test/harness-mermaid.mjs [wiki]
import { writeFileSync } from 'node:fs';
import { loadPages, wikiPath } from './pages.mts';

const pages = loadPages(wikiPath(process.argv[2]));
const sections = [];
for (const page of pages) {
  const text = page.text.replace(/\r\n/g, '\n');
  for (const m of text.matchAll(/^:::\s*mermaid[^\n]*\n[\s\S]*?\n[ \t]*:::[ \t]*$/gm))
    sections.push(`## ${page.path.split('/').pop()}\n\n${m[0]}`);
}
writeFileSync(new URL('./harness-page.js', import.meta.url), `window.__page = ${JSON.stringify(sections.join('\n\n'))};\n`);
console.log(`${sections.length} diagrams`);
