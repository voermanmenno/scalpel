// Unit tests for the ADO dialect in the parser (core/markdown.ts). Run: npm test
import { describe, expect, it } from 'vitest';
import { preprocess, parseAdo, mergeIntoSource } from '../src/core/markdown';

describe('preprocess: headings without a space', () => {
  it('adds the space in "#Kop" and "##3. Kop"', () => {
    expect(preprocess('#Kop').text).toBe('# Kop');
    expect(preprocess('##3. Aanmaken').text).toBe('## 3. Aanmaken');
    expect(preprocess('###20-03 Overleg').text).toBe('### 20-03 Overleg');
  });
  it('keeps "#123" at line start as a work item reference', () => {
    expect(preprocess('#364756 is klaar').text).toBe('#364756 is klaar');
  });
});

describe('macros on consecutive lines', () => {
  const src = 'Intro\n\n[[_TOC_]]\n[[_TOSP_]]\n\n# Kop\n';
  it('are one atom per line, with exact source offsets', () => {
    const atoms = parseAdo(src).children!.filter(n => n.type === 'adoRaw');
    expect(atoms.map(a => [a.kind, a.value])).toEqual([['toc', '[[_TOC_]]'], ['tosp', '[[_TOSP_]]']]);
    for (const a of atoms) expect(src.slice(a.position!.start.offset, a.position!.end.offset)).toBe(a.value);
  });
  it('survive an edit elsewhere byte-for-byte', () => {
    const edited = 'Intro gewijzigd\n\n[[_TOC_]]\n\n[[_TOSP_]]\n\n# Kop\n';
    expect(mergeIntoSource(src, edited)).toBe('Intro gewijzigd\n\n[[_TOC_]]\n[[_TOSP_]]\n\n# Kop\n');
  });
});
