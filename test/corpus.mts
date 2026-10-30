// Corpus test over every wiki page, using the real Milkdown editor in jsdom:
//  1. open and save without edits -> byte-identical;
//  2. type a word in a paragraph halfway the page -> the merged source, reopened in the editor,
//     gives exactly the edit, and the source diff is one changed line.
// Usage: npm run corpus [-- <wiki clone path>]   (SHOW=<n> prints n failures, CRLF=1 Windows line endings)
import './dom.mts';
import { loadPages, wikiPath } from './pages.mts';

const { createEditor, markdownOf, viewOf, acceptFor } = await import('../src/webview/milkdown');
const { toEditorMarkdown, mergeIntoSource, sameMarkdown } = await import('../src/core/markdown');

async function open(markdown: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await createEditor(root, markdown);
  return { editor, close: async () => { await editor.destroy(); root.remove(); } };
}

/// Removed + added lines between two texts.
function changedLines(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n');
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return (x.length - p - q) + (y.length - p - q);
}

function firstDiff(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, a.lastIndexOf('\n', i - 1) + 1);
  return `  a: ${JSON.stringify(a.slice(from, i + 80))}\n  b: ${JSON.stringify(b.slice(from, i + 80))}`;
}

function lineDiff(a: string, b: string) {
  const x = a.split('\n'), y = b.split('\n');
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  return [...x.slice(p, x.length - q).map(l => '- ' + l), ...y.slice(p, y.length - q).map(l => '+ ' + l)].join('\n');
}

const pages = loadPages(wikiPath(process.argv[2])).filter(p => !process.env.FILTER || p.path.includes(process.env.FILTER));
// CRLF=1: pages with Windows line endings, as VS Code hands them over from a Windows checkout
if (process.env.CRLF) for (const page of pages) page.text = page.text.replace(/\r?\n/g, '\r\n');
const stats = { identical: 0, crashed: 0, edited: 0, editCorrect: 0, oneLine: 0, fullRewrite: 0 };
const failures: string[] = [];

for (const page of pages) {
  try {
    const { editor, close } = await open(toEditorMarkdown(page.text));
    const base = markdownOf(editor);
    const unchanged = mergeIntoSource(page.text, base, base);
    if (unchanged === page.text) stats.identical++;
    else failures.push(`${page.path}\nNO-EDIT\n${firstDiff(page.text, unchanged)}`);

    const view = viewOf(editor);
    const ends: number[] = [];
    view.state.doc.descendants((n, pos) => {
      if ((n.type.name === 'paragraph' || n.type.name === 'heading') && n.textContent.trim()) ends.push(pos + n.nodeSize - 1);
    });
    if (ends.length) {
      stats.edited++;
      view.dispatch(view.state.tr.insertText(' gewijzigd', ends[Math.floor(ends.length / 2)]));
      const edited = markdownOf(editor);
      const merged = mergeIntoSource(page.text, edited, base, acceptFor(editor, edited));
      if (merged === edited && edited !== page.text) stats.fullRewrite++;
      const again = await open(toEditorMarkdown(merged));
      const reopened = markdownOf(again.editor);
      await again.close();
      // Reference: the edit as the editor renders it after a reload (Milkdown is not always idempotent).
      const ref = await open(edited);
      const expected = markdownOf(ref.editor);
      await ref.close();
      if (process.env.FILTER) console.log(lineDiff(page.text, merged));
      if (!sameMarkdown(reopened, expected)) failures.push(`${page.path}\nEDIT WRONG\n${firstDiff(expected, reopened)}`);
      else {
        stats.editCorrect++;
        const changed = changedLines(page.text, merged);
        if (changed === 2) stats.oneLine++;
        else failures.push(`${page.path}\nEDIT ${changed} lines\n${firstDiff(page.text, merged)}`);
      }
    }
    await close();
  } catch (e) {
    stats.crashed++;
    failures.push(`${page.path}\nCRASH ${(e as Error).message.split('\n')[0]}`);
  }
}
console.log(`pages: ${pages.length}, no-edit byte-identical: ${stats.identical}, crashed: ${stats.crashed}`);
console.log(`edits: ${stats.edited}, correct after reopen: ${stats.editCorrect}, one-line diff: ${stats.oneLine}, full rewrites: ${stats.fullRewrite}`);
console.log(failures.slice(0, Number(process.env.SHOW ?? 15)).join('\n---\n'));
process.exit(stats.identical === pages.length && stats.editCorrect === stats.edited ? 0 : 1);
