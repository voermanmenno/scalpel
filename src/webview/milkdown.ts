// Milkdown editor setup with ADO-wiki nodes. DOM-only: no VS Code API, so it also runs headless in tests.
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark, imageSchema, htmlSchema } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { $node, $prose, $remark, $view, getMarkdown } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import remarkFrontmatter from 'remark-frontmatter';
import { remarkAdo, toEditorMarkdown, sameMarkdown, IMAGE_SIZE, type AdoRawKind } from '../core/markdown';
import { renderMermaid, mermaidSource } from './mermaid';
import { lookup, onLookup } from './lookup';
import { openDiagramViewer, openSourceEditor } from './overlay';
import { t } from './l10n';

export interface EditorOptions {
  /// Map a Markdown image URL (e.g. '/.attachments/x.png') to a URL the webview can load.
  resolveSrc?: (src: string) => string | Promise<string>;
  onChange?: (markdown: string) => void;
}

// ---- inline HTML ------------------------------------------------------------------------------
// Inline tags ('<span style="color:...">', '</span>', '<br>') are separate atoms in the document.
// Show <br> as a line break and other tags as small chips; the text between a matching open and
// close tag gets the tag's formatting through a decoration.

const OPEN_TAG = /^<([a-z][a-z0-9]*)\b([^>]*?)\s*>$/i;
const CLOSE_TAG = /^<\/([a-z][a-z0-9]*)\s*>$/i;
const VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr']);
const MENTION = /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>$/i;

const TAG_STYLES: Record<string, string> = {
  b: 'font-weight:bold', strong: 'font-weight:bold', i: 'font-style:italic', em: 'font-style:italic',
  u: 'text-decoration:underline', ins: 'text-decoration:underline', s: 'text-decoration:line-through',
  strike: 'text-decoration:line-through', del: 'text-decoration:line-through',
  sup: 'vertical-align:super;font-size:0.8em', sub: 'vertical-align:sub;font-size:0.8em',
  mark: 'background:#fff3a3;color:#1f1f1f', code: 'font-family:monospace', small: 'font-size:0.85em',
};

function styleOf(name: string, attrs: string): string {
  const parts = [TAG_STYLES[name.toLowerCase()] ?? ''];
  const style = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  if (style) parts.push(style[2] ?? style[3]);
  const color = /\bcolor\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  if (color && name.toLowerCase() === 'font') parts.push(`color:${color[2] ?? color[3]}`);
  return parts.filter(Boolean).join(';');
}

function htmlDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    const open: { name: string; style: string; from: number }[] = [];
    block.forEach((child, offset) => {
      if (child.type.name !== 'html') return;
      const value = String(child.attrs.value).trim();
      const pos = blockPos + 1 + offset;
      const opening = OPEN_TAG.exec(value);
      const closing = CLOSE_TAG.exec(value);
      if (opening && !VOID_TAGS.has(opening[1].toLowerCase()) && !value.endsWith('/>') && !MENTION.test(value))
        open.push({ name: opening[1].toLowerCase(), style: styleOf(opening[1], opening[2]), from: pos + child.nodeSize });
      else if (closing) {
        const i = open.map(o => o.name).lastIndexOf(closing[1].toLowerCase());
        if (i < 0) return;
        const [tag] = open.splice(i, 1);
        if (tag.style && pos > tag.from) decorations.push(Decoration.inline(tag.from, pos, { style: tag.style }));
      }
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

const htmlStylePlugin = $prose(() => new Plugin({
  key: new PluginKey('adoHtmlStyle'),
  state: {
    init: (_config, state) => htmlDecorations(state.doc),
    apply: (tr, old) => (tr.docChanged ? htmlDecorations(tr.doc) : old),
  },
  props: { decorations(state) { return this.getState(state); } },
}));

// ---- work item references -------------------------------------------------------------------
// '#123456' in text (not in code or links) is shown as a chip with the work item's title.

const WORKITEM = /(^|[\s(\[,;:])#(\d{2,7})\b/g;
const workitemKey = new PluginKey('adoWorkitems');

/// Host lookup result: JSON {type, title, state}.
export function parseWorkitem(value: string | null | undefined): { type: string; title: string; state: string } | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function workitemDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText) return true;
    if (parent?.type.name === 'code_block' || node.marks.some(m => m.type.name === 'inlineCode' || m.type.name === 'link')) return false;
    for (const m of node.text!.matchAll(WORKITEM)) {
      const from = pos + m.index! + m[1].length;
      const to = from + 1 + m[2].length;
      const item = parseWorkitem(lookup('workitem', m[2]));
      const title = item ? `${item.type} ${m[2]}: ${item.title} (${item.state})\n` : '';
      decorations.push(Decoration.inline(from, to, { class: 'ado-workitem', 'data-workitem': m[2], title: `${title}${t('Ctrl+click to open')}` }));
      if (item) decorations.push(Decoration.widget(to, () => {
        const span = document.createElement('span');
        span.className = 'ado-workitem-title';
        span.textContent = item.title;
        return span;
      }, { side: 1, key: `workitem-${m[2]}-${item.title}` }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

const workitemPlugin = $prose(() => new Plugin({
  key: workitemKey,
  state: {
    init: (_config, state) => workitemDecorations(state.doc),
    apply: (tr, old) => (tr.docChanged || tr.getMeta(workitemKey) ? workitemDecorations(tr.doc) : old),
  },
  props: { decorations(state) { return this.getState(state); } },
  // titles arrive later: redraw then
  view: view => ({ destroy: onLookup(() => view.dispatch(view.state.tr.setMeta(workitemKey, true))) }),
}));

const htmlView = $view(htmlSchema.node, () => (node: ProseNode) => {
  const value = String(node.attrs.value).trim();
  if (/^<br\s*\/?>$/i.test(value)) {
    const dom = document.createElement('span');
    dom.className = 'ado-html-br';
    dom.title = value;
    dom.append(document.createElement('br'));
    return { dom, ignoreMutation: () => true };
  }
  const dom = document.createElement('span');
  if (MENTION.test(value)) {
    // ADO mention '@<GUID>': remark reads the GUID as a tag; show the person's name once looked up.
    const guid = value.slice(1, -1);
    dom.className = 'ado-mention';
    dom.title = t('Mention {0}', value);
    const show = () => { dom.textContent = lookup('identity', guid) ?? t('person'); };
    show();
    const unsubscribe = onLookup(show);
    return { dom, ignoreMutation: () => true, destroy: unsubscribe };
  }
  dom.className = 'ado-html-tag';
  const tag = OPEN_TAG.exec(value) ?? CLOSE_TAG.exec(value);
  dom.textContent = tag ? (value.startsWith('</') ? `/${tag[1]}` : tag[1]) : value;
  dom.title = value;
  return { dom, ignoreMutation: () => true };
});

const remarkFrontmatterPlugin = $remark('remarkFrontmatter', () => remarkFrontmatter as any, ['yaml']);
const remarkAdoPlugin = $remark('remarkAdo', () => remarkAdo as any);

/// Block atom for ADO constructs the editor must not rewrite; serialised verbatim as raw Markdown.
export const adoRawNode = $node('ado_raw', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  isolating: true,
  attrs: { kind: { default: 'html' }, value: { default: '' } },
  parseDOM: [{
    tag: 'div[data-ado-raw]',
    getAttrs: dom => ({ kind: (dom as HTMLElement).dataset.kind, value: (dom as HTMLElement).dataset.value }),
  }],
  toDOM: node => ['div', { 'data-ado-raw': '', 'data-kind': node.attrs.kind, 'data-value': node.attrs.value }, node.attrs.value],
  parseMarkdown: {
    match: n => n.type === 'adoRaw',
    runner: (state, n, type) => { state.addNode(type, { kind: n.kind, value: n.value }); },
  },
  toMarkdown: {
    match: n => n.type.name === 'ado_raw',
    runner: (state, n) => { state.addNode('html', undefined, n.attrs.value); },
  },
}));

/// Header label of an atom (translated when shown, so the bundle is read after the page loaded).
const LABELS: Record<AdoRawKind, () => string> = {
  frontmatter: () => t('Tags'),
  html: () => 'HTML',
  container: () => t('Block'),
  toc: () => t('Table of contents [[_TOC_]]'),
  tosp: () => t('Subpages [[_TOSP_]]'),
  definition: () => t('Link definition'),
};

/// Render the atom (read-only preview); double-click opens its source in a textarea.
function renderRaw(body: HTMLElement, kind: AdoRawKind, value: string, view: EditorView) {
  body.replaceChildren();
  if (kind === 'frontmatter') {
    // Like the ADO wiki: one row, tag names as column headers.
    const tags = value.split(/\r?\n/).map(line => /^\s*-\s*([^:]+):\s*(.*?)\s*$/.exec(line)).filter(m => m !== null);
    if (!tags.length) { body.append(pre(value)); return; }
    const table = document.createElement('table');
    table.className = 'ado-tags';
    const head = table.createTHead().insertRow();
    const row = table.createTBody().insertRow();
    for (const [, name, tagValue] of tags) {
      const th = document.createElement('th');
      th.textContent = name.trim();
      head.append(th);
      row.insertCell().textContent = tagValue;
    }
    body.append(table);
  } else if (kind === 'toc') {
    renderToc(body, view);
  } else if (kind === 'html') {
    const div = document.createElement('div');
    div.innerHTML = value;
    body.append(div);
  } else if (isMermaid(kind, value)) {
    const diagram = document.createElement('div');
    diagram.className = 'ado-mermaid';
    const loading = document.createElement('span');
    loading.className = 'ado-mermaid-loading';
    loading.textContent = t('Loading diagram…');
    diagram.append(loading);
    body.append(diagram);
    renderMermaid(mermaidSource(value), diagram).then(ok => { if (!ok && !diagram.querySelector('.ado-mermaid-error')) diagram.replaceWith(pre(value)); });
  } else {
    body.append(pre(value));
  }
}

const isMermaid = (kind: AdoRawKind, value: string) => kind === 'container' && /^:::\s*mermaid\b/.test(value);

/// Table of contents like the ADO wiki: a 'Contents' box with nested, clickable headings.
function renderToc(body: HTMLElement, view: EditorView) {
  const title = document.createElement('div');
  title.className = 'ado-toc-title';
  title.textContent = t('Contents');
  const root = document.createElement('ul');
  // stack of open lists; a deeper heading opens a sub-list under the previous item
  const stack: { level: number; list: HTMLUListElement }[] = [];
  view.state.doc.descendants((n, pos) => {
    if (n.type.name !== 'heading') return true;
    const level = Number(n.attrs.level);
    while (stack.length > 1 && level < stack[stack.length - 1].level) stack.pop();
    if (!stack.length) stack.push({ level, list: root });
    const top = stack[stack.length - 1];
    if (level > top.level && top.list.lastElementChild) {
      const sub = document.createElement('ul');
      top.list.lastElementChild.append(sub);
      stack.push({ level, list: sub });
    }
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.textContent = n.textContent;
    link.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      (view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.append(link);
    stack[stack.length - 1].list.append(li);
    return false;
  });
  body.append(title, root);
}

/// TOC views re-render after every document change (headings may have changed).
const tocRefreshers = new Set<() => void>();
const tocRefreshPlugin = $prose(() => new Plugin({
  key: new PluginKey('adoTocRefresh'),
  view: () => ({ update: (view, previous) => { if (!view.state.doc.eq(previous.doc)) tocRefreshers.forEach(refresh => refresh()); } }),
}));

function pre(text: string) {
  const el = document.createElement('pre');
  el.textContent = text;
  return el;
}

const adoRawView = $view(adoRawNode, () => (initial: ProseNode, view: EditorView, getPos: () => number | undefined) => {
  let node = initial;
  const dom = document.createElement('div');
  dom.className = 'ado-raw';
  const header = document.createElement('div');
  header.className = 'ado-raw-header';
  const body = document.createElement('div');
  body.className = 'ado-raw-body';
  dom.append(header, body);

  const show = () => {
    const kind = node.attrs.kind as AdoRawKind;
    const name = kind === 'container' ? /^:::\s*(\S+)/.exec(node.attrs.value)?.[1] ?? 'container' : '';
    const label = document.createElement('span');
    label.textContent = `${LABELS[kind]()}${name ? `: ${name}` : ''}`;
    header.replaceChildren(label);
    if (isMermaid(kind, node.attrs.value)) {
      const enlarge = document.createElement('button');
      enlarge.className = 'ado-raw-action';
      enlarge.textContent = `⛶ ${t('Enlarge')}`;
      enlarge.title = t('View the diagram large, with zoom');
      enlarge.addEventListener('mousedown', event => event.preventDefault());
      enlarge.addEventListener('click', event => {
        event.stopPropagation();
        const svg = body.querySelector('.ado-mermaid svg');
        if (svg) openDiagramViewer(svg.outerHTML);
      });
      const editButton = document.createElement('button');
      editButton.className = 'ado-raw-action';
      editButton.textContent = `✎ ${t('Edit source')}`;
      editButton.addEventListener('mousedown', event => event.preventDefault());
      editButton.addEventListener('click', event => { event.stopPropagation(); edit(); });
      header.append(enlarge, editButton);
    }
    dom.title = t('Double-click to edit the source');
    dom.dataset.kind = kind;
    renderRaw(body, kind, node.attrs.value, view);
  };

  /// The source is edited in a full-window overlay (outside ProseMirror, so the caret shows).
  const edit = () => {
    const kind = node.attrs.kind as AdoRawKind;
    const value = String(node.attrs.value);
    // a diagram is edited without its '::: mermaid' / ':::' lines, which are put back on apply
    const wrapper = isMermaid(kind, value) ? /^(:::[^\n]*\n)([\s\S]*?)(\n[ \t]*:::[ \t]*)$/.exec(value) : null;
    openSourceEditor({
      title: wrapper ? t('Edit diagram') : t('Edit {0}', LABELS[kind]()),
      value: wrapper ? wrapper[2] : value,
      render: wrapper ? (text, target) => renderMermaid(text, target) : undefined,
      onApply: text => {
        const pos = getPos();
        const next = wrapper ? wrapper[1] + text + wrapper[3] : text;
        if (pos !== undefined) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value: next }));
      },
    });
  };
  dom.addEventListener('dblclick', edit);
  show();
  const refresh = () => { if (node.attrs.kind === 'toc') renderToc(body.replaceChildren() ?? body, view); };
  tocRefreshers.add(refresh);

  return {
    dom,
    destroy: () => { tocRefreshers.delete(refresh); },
    update: (n: ProseNode) => {
      if (n.type !== node.type) return false;
      const changed = n.attrs.value !== node.attrs.value || n.attrs.kind !== node.attrs.kind;
      node = n;
      if (changed) show(); // re-rendering an unchanged diagram is costly
      return true;
    },
    stopEvent: (e: Event) => (e.target as HTMLElement).closest?.('.ado-raw-action') !== null && e.type !== 'dragstart',
    ignoreMutation: () => true,
  };
});

/// Images that could not be loaded (e.g. not signed in yet); `retryFailedImages` loads them again.
const failedImages = new Set<() => void>();
export function retryFailedImages() {
  [...failedImages].forEach(show => show());
}

export async function createEditor(root: HTMLElement, markdown: string, options: EditorOptions = {}): Promise<Editor> {
  const resolve = options.resolveSrc ?? (s => s);
  const imageView = $view(imageSchema.node, () => (node: ProseNode) => {
    const img = document.createElement('img');
    img.alt = node.attrs.alt;
    let title = node.attrs.title ? String(node.attrs.title) : '';
    const size = IMAGE_SIZE.exec(title);
    if (size) {
      // ADO size '=600x' / '=600x400' arrives as the image title (see preprocess)
      if (size[1]) img.style.width = `${size[1]}px`;
      if (size[2]) img.style.height = `${size[2]}px`;
      title = '';
    }
    const show = () => {
      const src = resolve(node.attrs.src);
      if (typeof src === 'string') { img.src = src; return; }
      src.then(url => {
        img.src = url;
        img.classList.remove('ado-image-missing');
        img.title = title;
        failedImages.delete(show);
      }, () => {
        img.classList.add('ado-image-missing');
        img.title = t('Image not available: {0}', node.attrs.src);
        failedImages.add(show);
      });
    };
    img.title = title;
    show();
    return { dom: img, ignoreMutation: () => true, destroy: () => { failedImages.delete(show); } };
  });

  return Editor.make()
    .config(ctx => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => { if (md !== prev) options.onChange?.(md); });
    })
    .use(remarkFrontmatterPlugin)
    .use(remarkAdoPlugin)
    .use(commonmark)
    .use(gfm)
    // No Milkdown history: VS Code handles Ctrl+Z/Ctrl+Y on the text document itself.
    .use(listener)
    .use(clipboard)
    .use(adoRawNode)
    .use(adoRawView)
    .use(imageView)
    .use(htmlView)
    .use(htmlStylePlugin)
    .use(tocRefreshPlugin)
    .use(workitemPlugin)
    .create();
}

export const markdownOf = (editor: Editor) => editor.action(getMarkdown());
export const viewOf = (editor: Editor) => editor.action(ctx => ctx.get(editorViewCtx));

/// Acceptance check for `mergeIntoSource`: the candidate source must load in this editor with the
/// same content as `edited` (no DOM needed: parser + serialiser only).
export function acceptFor(editor: Editor, edited: string) {
  return (candidate: string) => editor.action(ctx => {
    const doc = ctx.get(parserCtx)(toEditorMarkdown(candidate));
    return sameMarkdown(ctx.get(serializerCtx)(doc), edited);
  });
}
