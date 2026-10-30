// Webview entry: Milkdown editor + toolbar. Merges every edit into the page source (only changed
// parts are rewritten) and hands the new source to the extension host.
import type { Editor } from '@milkdown/kit/core';
import { callCommand, replaceAll } from '@milkdown/kit/utils';
import {
  toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, wrapInHeadingCommand, turnIntoTextCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, wrapInBlockquoteCommand, createCodeBlockCommand,
} from '@milkdown/kit/preset/commonmark';
import { toggleStrikethroughCommand, insertTableCommand } from '@milkdown/kit/preset/gfm';
import { addColumnAfter, deleteRow, deleteColumn, isInTable } from '@milkdown/kit/prose/tables';
import { TextSelection, type Command } from '@milkdown/kit/prose/state';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import '@milkdown/kit/prose/tables/style/tables.css';
import './style.css';
import { createEditor, markdownOf, viewOf, acceptFor, retryFailedImages } from './milkdown';
import { setMermaidUrl } from './mermaid';
import { setLookupTransport, receiveLookup, retryLookups, type LookupKind } from './lookup';
import { toEditorMarkdown, mergeIntoSource } from '../core/markdown';
import { t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

type HostMessage =
  | { type: 'load'; text: string; mermaidUrl: string }
  | { type: 'external'; text: string; reason: 'undo' | 'redo' | 'external' }
  | { type: 'image'; id: number; url: string | null }
  | { type: 'reloadImages' }
  | { type: 'reveal'; text: string }
  | { type: 'attachmentSaved'; id: number; path: string | null }
  | { type: 'lookup'; kind: LookupKind; key: string; value: string | null };

/// Wiki-relative images ('/.attachments/x.png') are resolved by the host: from disk, or from git
/// when the file is not in the (sparse) checkout.
const images = new Map<string, Promise<string>>();
const pendingImages = new Map<number, (url: string | null) => void>();
let nextImageId = 0;
function resolveImage(src: string): string | Promise<string> {
  // Azure DevOps-hosted images need a signed-in request: the host fetches those too.
  const viaHost = src.startsWith('/') || /^https:\/\/(dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)\//i.test(src);
  if (!viaHost) return src;
  let url = images.get(src);
  if (!url) {
    const id = nextImageId++;
    url = new Promise<string>((resolve, reject) => pendingImages.set(id, u => (u ? resolve(u) : reject(new Error(src)))));
    images.set(src, url);
    vscode.postMessage({ type: 'image', id, src });
  }
  return url;
}

let editor: Editor | undefined;
/// The page source as it is in the document, and the editor's rendering of it (see mergeIntoSource).
let src = '';
let base = '';
let loading = false;

const status = document.getElementById('status')!;
const setStatus = (text: string, warn = false) => {
  status.textContent = text;
  status.classList.toggle('warn', warn);
};

function onChange(markdown: string) {
  if (loading || !editor || markdown === base) return;
  const merged = mergeIntoSource(src, markdown, base, acceptFor(editor, markdown));
  if (merged === src) return;
  const rewritten = merged === markdown && src.replace(/\r\n/g, '\n') !== markdown;
  setStatus(rewritten ? t('Note: this change rewrites the formatting of the whole page') : t('Changed'), rewritten);
  src = merged;
  base = markdown;
  vscode.postMessage({ type: 'edit', text: merged });
}

async function load(text: string) {
  loading = true;
  src = text;
  const markdown = toEditorMarkdown(text);
  if (!editor) {
    editor = await createEditor(document.getElementById('editor')!, markdown, {
      onChange,
      resolveSrc: resolveImage,
    });
  } else {
    editor.action(replaceAll(markdown, true));
  }
  base = markdownOf(editor);
  loading = false;
}

let markLoaded: () => void;
const loaded = new Promise<void>(resolve => { markLoaded = resolve; });

/// Select the first occurrence of `text` (case-insensitive) and scroll to it (search results).
function reveal(text: string) {
  if (!editor) return;
  const view = viewOf(editor);
  const needle = text.toLowerCase();
  let found: number | undefined;
  view.state.doc.descendants((node, pos) => {
    if (found !== undefined) return false;
    if (!node.isTextblock) return true;
    const index = node.textContent.toLowerCase().indexOf(needle);
    if (index < 0) return false;
    // map the offset in the block's text to a document position
    let offset = 0;
    node.forEach((child, childOffset) => {
      if (found !== undefined) return;
      const length = child.isText ? child.text!.length : child.textContent.length;
      if (index < offset + length) found = pos + 1 + childOffset + (child.isText ? index - offset : 0);
      offset += length;
    });
    return false;
  });
  if (found === undefined) { setStatus(t('"{0}" is not in the text of this page (it may be in a tag or diagram)', text)); return; }
  const selection = TextSelection.create(view.state.doc, found, Math.min(found + text.length, view.state.doc.content.size));
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
  (view.domAtPos(found).node as HTMLElement).parentElement?.scrollIntoView({ block: 'center' });
}

/// Load new document text while keeping the cursor and scroll position (undo/redo, outside edits).
async function reload(text: string) {
  const view = editor && viewOf(editor);
  const selection = view?.state.selection.from ?? 0;
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  await load(text);
  if (!editor) return;
  const next = viewOf(editor);
  const pos = Math.min(selection, next.state.doc.content.size);
  next.dispatch(next.state.tr.setSelection(TextSelection.near(next.state.doc.resolve(pos))));
  next.focus();
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
}

window.addEventListener('message', async (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'image') {
    pendingImages.get(message.id)?.(message.url);
    pendingImages.delete(message.id);
  } else if (message.type === 'attachmentSaved') {
    pendingAttachments.get(message.id)?.(message.path);
    pendingAttachments.delete(message.id);
  } else if (message.type === 'lookup') {
    receiveLookup(message.kind, message.key, message.value);
  } else if (message.type === 'reloadImages') {
    // signed in: forget failed lookups and load those images, names and titles again
    images.clear();
    retryFailedImages();
    retryLookups();
  } else if (message.type === 'reveal') {
    await loaded;
    reveal(message.text);
  } else if (message.type === 'load') {
    setMermaidUrl(message.mermaidUrl);
    await load(message.text);
    markLoaded();
    setStatus('');
  } else if (message.type === 'external' && message.text !== src) {
    await reload(message.text);
    setStatus(message.reason === 'undo' ? t('Undone') : message.reason === 'redo' ? t('Redone')
      : t('Page reloaded (changed outside the editor)'));
  }
});

// ---- toolbar ----------------------------------------------------------------------------------
/// A Milkdown command's key only exists once the editor runs: read it at click time.
const run = (command: { key: Parameters<typeof callCommand>[0] }, payload?: unknown) => () =>
  editor?.action(callCommand(command.key, payload));
const prose = (command: Command) => () => {
  if (!editor) return;
  const view = viewOf(editor);
  command(view.state, view.dispatch);
  view.focus();
};

/// Add an empty body row below the current row (also from the header row, where the generic
/// prosemirror-tables command would build a row of header cells, which this schema forbids)
/// and put the cursor in its first cell.
const addRowAndEnter: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const { $from } = state.selection;
  let depth = $from.depth;
  while (depth > 0 && !/^table(_header)?_row$/.test($from.node(depth).type.name)) depth--;
  if (depth === 0) return false;
  const row = $from.node(depth);
  const { table_row: rowType, table_cell: cellType } = state.schema.nodes;
  const cells: ProseNode[] = [];
  row.forEach(() => { const cell = cellType.createAndFill(); if (cell) cells.push(cell); });
  const insertAt = $from.after(depth);
  // A header-only table gets a body row without cells from the editor (the schema needs a row):
  // replace that placeholder instead of adding a row next to it.
  const next = state.doc.nodeAt(insertAt);
  const placeholder = next && next.type === rowType && next.childCount === 0 ? next.nodeSize : 0;
  const tr = state.tr.replaceWith(insertAt, insertAt + placeholder, rowType.create(null, cells));
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 2)));
  dispatch?.(tr.scrollIntoView());
  return true;
};

const actions: Record<string, () => void> = {
  bold: run(toggleStrongCommand),
  italic: run(toggleEmphasisCommand),
  strike: run(toggleStrikethroughCommand),
  code: run(toggleInlineCodeCommand),
  h1: run(wrapInHeadingCommand, 1),
  h2: run(wrapInHeadingCommand, 2),
  h3: run(wrapInHeadingCommand, 3),
  text: run(turnIntoTextCommand),
  bullet: run(wrapInBulletListCommand),
  ordered: run(wrapInOrderedListCommand),
  quote: run(wrapInBlockquoteCommand),
  codeblock: run(createCodeBlockCommand),
  table: run(insertTableCommand, { row: 3, col: 3 }),
  addRow: prose(addRowAndEnter),
  addCol: prose(addColumnAfter),
  delRow: prose(deleteRow),
  delCol: prose(deleteColumn),
  source: () => vscode.postMessage({ type: 'openSource' }),
  publish: () => vscode.postMessage({ type: 'publish' }),
};

document.getElementById('toolbar')!.addEventListener('mousedown', event => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;
  event.preventDefault(); // keep the editor selection
  actions[button.dataset.action!]?.();
});

// Links: a plain click places the cursor (so link text stays editable), Ctrl+click opens the link:
// a wiki page in this editor, anything else in the browser.
const editorElement = document.getElementById('editor')!;
setLookupTransport((kind, key) => vscode.postMessage({ type: 'lookup', kind, key }));
editorElement.addEventListener('click', event => {
  const workitem = (event.target as HTMLElement).closest<HTMLElement>('.ado-workitem');
  if (workitem && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    vscode.postMessage({ type: 'openWorkitem', id: workitem.dataset.workitem });
    return;
  }
  const link = (event.target as HTMLElement).closest('a');
  if (!link) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) vscode.postMessage({ type: 'openLink', href: link.getAttribute('href') });
});
// Paste or drop an image: the host stores it as '.attachments/image-<guid>.<ext>' (as ADO does)
// and the editor inserts '![image.png](/.attachments/...)' at the cursor.
const pendingAttachments = new Map<number, (path: string | null) => void>();
let nextAttachmentId = 0;
function saveAttachment(file: File): Promise<string | null> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const id = nextAttachmentId++;
      pendingAttachments.set(id, resolve);
      vscode.postMessage({ type: 'saveAttachment', id, name: file.name, mime: file.type, data: String(reader.result).split(',')[1] });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function insertImages(files: File[], pos?: number) {
  if (!editor) return;
  for (const file of files) {
    const path = await saveAttachment(file);
    if (!path) { setStatus(t('Could not save image: {0}', file.name), true); continue; }
    const view = viewOf(editor);
    const image = view.state.schema.nodes.image.create({ src: path, alt: 'image.png', title: '' });
    const tr = pos === undefined ? view.state.tr.replaceSelectionWith(image) : view.state.tr.insert(pos, image);
    view.dispatch(tr.scrollIntoView());
  }
}

const imageFiles = (list: FileList | null | undefined) => [...(list ?? [])].filter(f => f.type.startsWith('image/'));
editorElement.addEventListener('paste', event => {
  const files = imageFiles(event.clipboardData?.files);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  insertImages(files);
}, true);
editorElement.addEventListener('drop', event => {
  const files = imageFiles(event.dataTransfer?.files);
  if (!files.length || !editor) return;
  event.preventDefault();
  event.stopPropagation();
  const target = viewOf(editor).posAtCoords({ left: event.clientX, top: event.clientY });
  insertImages(files, target?.pos);
}, true);

editorElement.addEventListener('mouseover', event => {
  const link = (event.target as HTMLElement).closest('a');
  if (link && !link.title) link.title = `${link.getAttribute('href')}\n${t('Ctrl+click to open')}`;
});

vscode.postMessage({ type: 'ready' });
