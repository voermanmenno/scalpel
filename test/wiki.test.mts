// Unit tests for page names and page creation (wiki.ts). Run: npm test
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pageTitle, pageFileName, createPage, commitMessage, english, type Translate } from '../src/wiki';

describe('commitMessage', () => {
  const page = 'Team/Sandbox/Release-%2D-Notes-(2026-%2D-Q3).md';
  it('names one page', () => {
    expect(commitMessage([{ status: ' M', file: page }])).toBe('Wiki: Release - Notes (2026 - Q3) updated');
    expect(commitMessage([{ status: '??', file: 'Team/New-page.md' }, { status: ' M', file: 'Team/.order' }]))
      .toBe('Wiki: New page created');
    expect(commitMessage([{ status: ' D', file: 'Old.md' }])).toBe('Wiki: Old deleted');
  });
  it('lists up to three pages, counts more', () => {
    expect(commitMessage([{ status: ' M', file: 'A.md' }, { status: ' M', file: 'B.md' }])).toBe('Wiki: A and B updated');
    expect(commitMessage(['A', 'B', 'C'].map(n => ({ status: ' M', file: `${n}.md` })))).toBe('Wiki: A, B and C updated');
    expect(commitMessage(['A', 'B', 'C', 'D'].map(n => ({ status: ' M', file: `${n}.md` })))).toBe('Wiki: 4 pages updated');
  });
  it('covers changes without pages', () => {
    expect(commitMessage([{ status: '??', file: '.attachments/image-x.png' }])).toBe('Wiki: attachments and order updated');
  });
  it('uses the translation', () => {
    const dutch: Record<string, string> = { 'Wiki: {0} updated': 'Wiki: {0} bijgewerkt', '{0} and {1}': '{0} en {1}' };
    const t: Translate = (message, ...args) => english(dutch[message] ?? message, ...args);
    expect(commitMessage([{ status: ' M', file: 'A.md' }, { status: ' M', file: 'B.md' }], t)).toBe('Wiki: A en B bijgewerkt');
  });
});

describe('page names', () => {
  it('decodes ADO file names', () => {
    expect(pageTitle('Export-%2D-ERP-sends-extracts.md')).toBe('Export - ERP sends extracts');
    expect(pageTitle('Compare-A-%3C%2D%3E-B')).toBe('Compare A <-> B');
    expect(pageTitle('001-Onboarding-%2D-Patiënt')).toBe('001 Onboarding - Patiënt');
  });

  it('encodes titles the way ADO names files', () => {
    for (const title of ['Export - ERP sends extracts', 'Compare A <-> B', 'Onboarding Patiënt', 'Alert: CPU 95%'])
      expect(pageTitle(pageFileName(title))).toBe(title);
    expect(pageFileName('Release - Notes for Q3')).toBe('Release-%2D-Notes-for-Q3');
  });
});

describe('createPage', () => {
  it('creates the file, the folder and the .order line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
    fs.writeFileSync(path.join(root, 'Parent.md'), '# Parent\n');
    const file = createPage(root, 'Parent.md', 'New page - test');
    expect(path.relative(root, file)).toBe(path.join('Parent', 'New-page-%2D-test.md'));
    expect(fs.readFileSync(path.join(root, 'Parent', '.order'), 'utf8')).toBe('New-page-%2D-test');
    createPage(root, 'Parent.md', 'Second');
    expect(fs.readFileSync(path.join(root, 'Parent', '.order'), 'utf8')).toBe('New-page-%2D-test\nSecond');
    expect(() => createPage(root, 'Parent.md', 'Second')).toThrow('The page already exists: Second');
    fs.rmSync(root, { recursive: true });
  });
});
