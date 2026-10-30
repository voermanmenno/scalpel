// Every translatable string in the code has a Dutch translation, and the bundles have no leftovers.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

/// Message literals of t('...') calls (single quotes; \' and \" escapes allowed).
function messages(): Set<string> {
  const found = new Set<string>();
  for (const file of sources('src')) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g))
      found.add(m[1].replace(/\\(.)/g, '$1'));
  }
  return found;
}

const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;

describe('translations', () => {
  it('runtime strings are all in the Dutch bundle and nothing is left over', () => {
    const used = messages();
    const dutch = json('l10n/bundle.l10n.nl.json');
    expect([...used].filter(m => !(m in dutch))).toEqual([]);
    expect(Object.keys(dutch).filter(m => !used.has(m))).toEqual([]);
  });

  it('package.json placeholders exist in both languages', () => {
    const keys = [...fs.readFileSync('package.json', 'utf8').matchAll(/"%([^%"]+)%"/g)].map(m => m[1]);
    expect(Object.keys(json('package.nls.json')).sort()).toEqual([...new Set(keys)].sort());
    expect(Object.keys(json('package.nls.nl.json')).sort()).toEqual([...new Set(keys)].sort());
  });
});
