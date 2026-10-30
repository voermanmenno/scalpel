// Read every .md page of a wiki clone straight from git (works with a sparse checkout).
import { execFileSync, spawnSync } from 'node:child_process';

/// The wiki clone to test against: the given argument, else the SCALPEL_WIKI environment variable.
export function wikiPath(argument?: string): string {
  const wiki = argument || process.env.SCALPEL_WIKI;
  if (!wiki) throw new Error('No wiki clone: pass its path as an argument or set SCALPEL_WIKI.');
  return wiki;
}

export function loadPages(wiki: string) {
  const tree = execFileSync('git', ['-C', wiki, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const entries = tree.split('\n').filter(l => l.endsWith('.md')).map(l => {
    const [meta, path] = l.split('\t');
    return { hash: meta.split(' ')[2], path, text: '' };
  });
  const out = spawnSync('git', ['-C', wiki, 'cat-file', '--batch'], { input: entries.map(e => e.hash).join('\n') + '\n', maxBuffer: 1 << 28 }).stdout;
  let pos = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, pos);
    const size = Number(out.subarray(pos, nl).toString().split(' ')[2]);
    const bytes = out.subarray(nl + 1, nl + 1 + size);
    // like VS Code: honour a UTF-16 byte order mark
    e.text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
    pos = nl + 1 + size + 1;
  }
  return entries;
}
