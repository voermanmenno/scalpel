// Debug one page: shows each merge candidate and why the editor rejects it.
// Usage: node --import tsx test/debug.mts <path-substring> [wiki clone path]
import './dom.mts';
import { loadPages, wikiPath } from './pages.mts';

const { createEditor, markdownOf, viewOf, acceptFor } = await import('../src/webview/milkdown');
const { toEditorMarkdown, mergeIntoSource } = await import('../src/core/markdown');

const page = loadPages(wikiPath(process.argv[3])).find(p => p.path.includes(process.argv[2]))!;
const root = document.createElement('div');
document.body.append(root);
const editor = await createEditor(root, toEditorMarkdown(page.text));
const base = markdownOf(editor);
const view = viewOf(editor);
const ends: number[] = [];
view.state.doc.descendants((n, pos) => {
  if ((n.type.name === 'paragraph' || n.type.name === 'heading') && n.textContent.trim()) ends.push(pos + n.nodeSize - 1);
});
view.dispatch(view.state.tr.insertText(' gewijzigd', ends[Math.floor(ends.length / 2)]));
const edited = markdownOf(editor);
const accept = acceptFor(editor, edited);
let n = 0;
mergeIntoSource(page.text, edited, base, candidate => {
  const ok = accept(candidate);
  console.log(`--- candidate ${++n}: ${ok ? 'accepted' : 'REJECTED'}`);
  console.log(diff(page.text, candidate));
  return ok;
});
process.exit(0);

function diff(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n');
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return [...x.slice(p, x.length - q).map(l => '- ' + l), ...y.slice(p, y.length - q).map(l => '+ ' + l)].join('\n');
}
