// ADO-wiki Markdown: parsing with the Azure DevOps dialect and source-preserving writing.
// Shared by the extension host (writing) and the webview (Milkdown parsing).
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify, { type Options as StringifyOptions } from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import DiffMatchPatch from 'diff-match-patch';
import { defaultHandlers } from 'mdast-util-to-markdown';

/// Loose mdast node: we only rely on type/children/value/position.
export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } };
  [key: string]: unknown;
}

/// Atom kinds the editor shows but never re-serialises: their source is kept byte-for-byte.
export type AdoRawKind = 'frontmatter' | 'html' | 'container' | 'toc' | 'tosp' | 'definition';

export interface AdoRawNode extends MdNode {
  type: 'adoRaw';
  kind: AdoRawKind;
  value: string;
}

/// ADO image size: '![alt](url =600x)' or '=600x400'.
export const IMAGE_SIZE = /^=(\d*)x(\d*)$/;

/// Make ADO-dialect Markdown valid CommonMark by inserting single characters:
/// - the missing space in headings written as '#Kop' or '##3. Kop' ('#123' at line start stays a work
///   item reference: only a single '#' followed by a digit);
/// - quotes around an image size, '](url =600x)' -> '](url "=600x")', so it parses as the image title.
/// Skips fenced code and ':::' containers. Returns the patched text plus the original offsets of
/// every inserted character (ascending).
export function preprocess(text: string): { text: string; inserts: number[] } {
  const inserts: number[] = [];
  let out = '';
  let fence: string | null = null;
  let container = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const at: { col: number; char: string }[] = [];
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
    } else if (container) {
      if (/^\s*:::\s*$/.test(line)) container = false;
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else if (/^:::\s*\S/.test(line)) {
      container = true;
    } else {
      const heading = /^(#{2,6})(?=[^#\s])/.exec(line) ?? /^(#)(?=[^#\s\d])/.exec(line);
      if (heading) at.push({ col: heading[1].length, char: ' ' });
      for (const m of line.matchAll(/!\[[^\]]*\]\([^)\s]+ (=\d*x\d*)\)/g)) {
        const sizeStart = m.index! + m[0].length - 1 - m[1].length;
        at.push({ col: sizeStart, char: '"' }, { col: sizeStart + m[1].length, char: '"' });
      }
    }
    let patched = '', last = 0;
    for (const { col, char } of at) {
      patched += line.slice(last, col) + char;
      inserts.push(offset + col);
      last = col;
    }
    out += patched + line.slice(last) + '\n';
    offset += line.length + 1;
  }
  return { text: out.slice(0, -1), inserts };
}

/// Page source as the editor loads it: LF line endings (the merge restores CRLF) and ADO dialect.
export function toEditorMarkdown(source: string): string {
  return preprocess(source.replace(/\r\n?/g, '\n')).text;
}

const MACRO = /^\[\[_(TOC|TOSP)_\]\]$/;
const CONTAINER_OPEN = /^:::\s*\S/;
const CONTAINER_CLOSE = /\n[ \t]*:::[ \t]*(?=\n|$)/g;

const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;

/// Shift positions of a sub-parse that started at `offset` (line `line`) of the full text.
function shift(node: MdNode, offset: number, line: number) {
  if (node.position) {
    const move = (p: { line: number; column: number; offset?: number }) =>
      ({ ...p, line: p.line + line - 1, offset: p.offset === undefined ? undefined : p.offset + offset });
    node.position = { start: move(node.position.start), end: move(node.position.end) };
  }
  node.children?.forEach(c => shift(c, offset, line));
}

/// remark transformer: turns ADO-specific constructs at the top level into `adoRaw` atoms.
export const remarkAdo: Plugin<[], any> = function (this: any) {
  const processor = this;
  return (tree: MdNode, file: { value?: unknown }) => transformAdo(processor, tree, String(file.value ?? ''));
};

function transformAdo(processor: any, tree: MdNode, text: string) {
  const children = tree.children ?? [];
  const result: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) { result.push(node); continue; }
    const raw = text.slice(start, end);
    const atom = (kind: AdoRawKind, value: string, last: MdNode = node): AdoRawNode =>
      ({ type: 'adoRaw', kind, value, position: { start: node.position!.start, end: last.position!.end } });
    if (node.type === 'yaml') result.push(atom('frontmatter', raw));
    else if (node.type === 'html') result.push(atom('html', raw));
    else if (node.type === 'definition') result.push(atom('definition', raw));
    else if (node.type === 'paragraph' && MACRO.test(raw.trim())) result.push(atom(raw.includes('TOSP') ? 'tosp' : 'toc', raw));
    else if (node.type === 'paragraph' && raw.split('\n').every(line => MACRO.test(line.trim()))) {
      // '[[_TOC_]]' and '[[_TOSP_]]' on consecutive lines: one atom per line, as ADO shows both
      let at = start;
      for (const line of raw.split('\n')) {
        const from = at + line.length - line.trimStart().length;
        const value = line.trim();
        const point = (offset: number) => ({ line: lineAt(text, offset), column: offset - text.lastIndexOf('\n', offset - 1), offset });
        result.push({ type: 'adoRaw', kind: value.includes('TOSP') ? 'tosp' : 'toc', value, position: { start: point(from), end: point(from + value.length) } } as AdoRawNode);
        at += line.length + 1;
      }
    } else if (CONTAINER_OPEN.test(raw)) {
      CONTAINER_CLOSE.lastIndex = start + 3;
      const close = CONTAINER_CLOSE.exec(text);
      if (!close) { result.push(node); continue; }
      const closeEnd = close.index + close[0].length;
      let last = node;
      while (i + 1 < children.length && (children[i + 1].position?.start.offset ?? Infinity) < closeEnd) last = children[++i];
      const container = atom('container', text.slice(start, closeEnd), last);
      container.position!.end = { line: lineAt(text, closeEnd), column: 4, offset: closeEnd };
      result.push(container);
      // The container body may have opened a block (indented code, HTML, a fence) that runs past
      // the closing ':::'. Parse whatever that block swallowed after the container again.
      const lastEnd = last.position!.end.offset!;
      if (lastEnd > closeEnd) {
        const rest = text.slice(closeEnd, lastEnd);
        const sub = processor.runSync(processor.parse(rest), rest) as MdNode;
        for (const child of sub.children ?? []) {
          shift(child, closeEnd, lineAt(text, closeEnd));
          result.push(child);
        }
      }
    } else result.push(node);
  }
  tree.children = result;
  splitMentions(tree, text);
}

const MENTION_IN_TEXT = /@(<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>)/gi;

/// ADO mentions '@<GUID>': remark reads '<F04F…>' as an HTML tag but '<1894…>' (digit first) as text.
/// Make every mention an inline 'html' node, so the editor shows it the same way in both cases.
function splitMentions(node: MdNode, text: string) {
  if (!node.children || node.type === 'adoRaw') return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type !== 'text' || !child.value || child.value.search(MENTION_IN_TEXT) < 0) {
      splitMentions(child, text);
      next.push(child);
      continue;
    }
    // Positions stay exact only when the text has no escapes or entities (source slice == value).
    const start = child.position?.start.offset;
    const exact = start !== undefined && text.slice(start, child.position!.end.offset) === child.value;
    const piece = (type: string, value: string, from: number): MdNode => ({
      type, value,
      ...(exact ? { position: { start: { line: 0, column: 0, offset: start! + from }, end: { line: 0, column: 0, offset: start! + from + value.length } } } : {}),
    });
    let last = 0;
    for (const m of child.value.matchAll(MENTION_IN_TEXT)) {
      const tagAt = m.index! + 1; // after the '@'
      next.push(piece('text', child.value.slice(last, tagAt), last));
      next.push(piece('html', m[1], tagAt));
      last = tagAt + m[1].length;
    }
    if (last < child.value.length) next.push(piece('text', child.value.slice(last), last));
  }
  node.children = next;
}

const stringifyOptions: StringifyOptions = {
  bullet: '-',
  fences: true,
  rule: '-',
  handlers: {
    adoRaw: (node: AdoRawNode) => node.value,
    // An image whose title is an ADO size ('=600x') is written back in ADO form: '![alt](url =600x)'.
    image: (node: MdNode, parent: unknown, state: any, info: unknown) => {
      if (typeof node.title === 'string' && IMAGE_SIZE.test(node.title))
        return `![${String(node.alt ?? '').replace(/[[\]\\]/g, '\\$&')}](${node.url} ${node.title})`;
      return defaultHandlers.image(node as any, parent as any, state, info as any);
    },
  } as any,
};

// Typed loosely: the custom adoRaw node is not part of the mdast types.
const processor: any = (unified() as any).use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).use(remarkAdo)
  .use(remarkStringify, stringifyOptions);

/// Parse ADO-wiki Markdown; node offsets refer to the ORIGINAL text (before `preprocess`).
export function parseAdo(text: string): MdNode {
  const pre = preprocess(text);
  const tree = processor.runSync(processor.parse(pre.text), pre.text) as MdNode;
  if (pre.inserts.length) remap(tree, pre.inserts);
  return tree;
}

function remap(node: MdNode, inserts: number[]) {
  const map = (p: number) => {
    // insertion k sits at preprocessed offset inserts[k] + k
    let k = 0;
    while (k < inserts.length && inserts[k] + k < p) k++;
    return p - k;
  };
  if (node.position) {
    if (node.position.start.offset !== undefined) node.position.start = { ...node.position.start, offset: map(node.position.start.offset) };
    if (node.position.end.offset !== undefined) node.position.end = { ...node.position.end, offset: map(node.position.end.offset) };
  }
  node.children?.forEach(c => remap(c, inserts));
}

export function stringifyAdo(tree: MdNode): string {
  return processor.stringify(tree as any);
}

// ---- source-preserving writer ---------------------------------------------------------------

const dmp = new DiffMatchPatch();
// Patches must land where they belong: little fuzz, verification catches the rest.
dmp.Match_Threshold = 0.2;
const INLINE = new Set(['text', 'strong', 'emphasis', 'delete', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'html', 'break', 'footnoteReference']);
const MARKS = new Set(['strong', 'emphasis', 'delete', 'link']);
const IGNORED = (k: string, v: unknown) => k === 'position' || k === 'spread' || v === null || (k === 'title' && v === '');

/// Inline content as flat runs of (leaf, sorted marks): '**_x_**' and '***x***' become equal,
/// just as they are in the editor (ProseMirror marks have no nesting order).
function runs(nodes: MdNode[], marks: string[] = [], out: { leaf: MdNode; marks: string }[] = []) {
  for (const n of nodes) {
    if (MARKS.has(n.type)) {
      const mark = n.type === 'link' ? `link:${n.url}|${n.title ?? ''}` : n.type;
      runs(n.children ?? [], [...marks, mark], out);
      continue;
    }
    const key = [...marks].sort().join(',');
    const prev = out.at(-1);
    if (n.type === 'text' && prev?.leaf.type === 'text' && prev.marks === key) prev.leaf = { type: 'text', value: prev.leaf.value + (n.value ?? '') };
    else out.push({ leaf: n, marks: key });
  }
  return out;
}

function canon(n: MdNode): unknown {
  if (INLINE.has(n.type)) return runs([n]);
  const { children, ...rest } = n;
  if (!children) return rest;
  return { ...rest, children: children.some(c => INLINE.has(c.type)) ? runs(children) : children.map(canon) };
}

const strip = (n: MdNode) => JSON.stringify(canon(n), (k, v) => (IGNORED(k, v) ? undefined : v));
const same = (a: MdNode, b: MdNode) => strip(a) === strip(b);
const slice = (src: string, n: MdNode) => src.slice(n.position!.start.offset, n.position!.end.offset);
const hasOffsets = (n: MdNode) => n.position?.start.offset !== undefined && n.position?.end.offset !== undefined;

const block = (n: MdNode) => stringifyAdo({ type: 'root', children: [n] }).replace(/\n$/, '');
/// Serialise inline content as it would appear mid-sentence: between two marker characters,
/// so a leading/trailing space is not escaped and no line break is added.
function inline(n: MdNode, parent?: MdNode | null): string {
  const out = block({ type: 'paragraph', children: [{ type: 'text', value: 'x' }, n, { type: 'text', value: 'x' }] });
  const body = dropNeedlessEscapes(out).slice(1, -1);
  return parent?.type === 'tableCell' ? body.replace(/(^|[^\\])\|/g, '$1\\|') : body;
}

/// remark escapes defensively ('Nieuw\.csv'); keep an escape only when removing it changes the meaning.
function dropNeedlessEscapes(text: string): string {
  if (!text.includes('\\')) return text;
  const meaning = strip(parseAdo(text));
  for (let i = text.indexOf('\\'); i >= 0; i = text.indexOf('\\', i + 1)) {
    const candidate = text.slice(0, i) + text.slice(i + 1);
    if (/[!-/:-@[-`{-~]/.test(text[i + 1] ?? '') && strip(parseAdo(candidate)) === meaning) text = candidate;
  }
  return text;
}

/// Serialise a node that has no usable original source, matching the style of its parent.
function serialiseNew(n: MdNode, parent: MdNode | null, src: string): string {
  if (n.type === 'tableRow') return '| ' + (n.children ?? []).map(c => (c.children ?? []).map(x => inline(x, c)).join('')).join(' | ') + ' |';
  if (n.type === 'listItem' && parent) {
    const out = block({ ...parent, children: [n] });
    const first = parent.children?.find(hasOffsets);
    const bullet = first ? slice(src, first).trimStart()[0] : '-';
    return parent.ordered || !'*+-'.includes(bullet) ? out : out.replace(/^-/, bullet);
  }
  return INLINE.has(n.type) ? inline(n, parent) : block(n);
}

interface WriteContext {
  src: string;
  /// Re-serialise every changed block whole instead of patching inside it.
  coarse: boolean;
  /// Set when a node was kept from the source because the user did not change it (base == next),
  /// although the editor's own rendering of it differs from the source (lossy editor normalisation).
  keptLossy: boolean;
}

/// Write `next` (edited tree) using the source of `orig` (parsed from `src`) for everything unchanged.
/// `base` is the editor's rendering of the document before the edit: whatever the user did not touch
/// (base == next) keeps its original bytes, even where the editor would write it differently.
/// Only the smallest changed nodes are re-serialised, leaf text via a character patch on the source.
function writeNode(orig: MdNode, next: MdNode, ctx: WriteContext, parent: MdNode | null, base?: MdNode): string {
  const { src } = ctx;
  if (!hasOffsets(orig)) return serialiseNew(next, parent, src);
  if (same(orig, next)) return slice(src, orig);
  if (base && same(base, next)) { ctx.keptLossy = true; return slice(src, orig); }
  if (ctx.coarse && parent) return serialiseNew(next, parent, src);
  if (orig.type === next.type && typeof orig.value === 'string' && typeof next.value === 'string' && !orig.children) {
    if (orig.type !== 'text') return serialiseNew(next, parent, src);
    const [patched, applied] = dmp.patch_apply(dmp.patch_make(orig.value, next.value), slice(src, orig));
    return applied.every(Boolean) ? patched : serialiseNew(next, parent, src);
  }
  const a = orig.children, b = next.children;
  if (orig.type === 'tableCell' && next.type === 'tableCell' && a?.length === 0) {
    // An empty cell's source is just its pipes and padding ('|  '): fill it in place.
    const cell = slice(src, orig);
    const content = (b ?? []).map(x => inline(x, next)).join('');
    return (cell.startsWith('|') ? '| ' : ' ') + content + (cell.length > 1 && cell.endsWith('|') ? ' |' : ' ');
  }
  if (orig.type !== next.type || !a || !b || a.length === 0 || !a.every(hasOffsets)) return serialiseNew(next, parent, src);
  // Base children only help when they line up one-to-one with the source children.
  const baseKids = base?.children?.length === a.length && base.children.every((c, i) => c.type === a[i].type) ? base.children : undefined;
  const eq = (i: number, j: number) => same(a[i], b[j]) || (!!baseKids && same(baseKids[i], b[j]));
  // The editor restructured this node (e.g. a lazily indented list): its children no longer line up
  // with the source. Apply the edit as a text patch (base -> next rendering) onto the source instead.
  const aligned = a.length === b.length && a.every((c, i) => c.type === b[i].type);
  if (base && !baseKids && !aligned && base.type === next.type) {
    const render = (n: MdNode) => (INLINE.has(n.type) ? inline(n) : block(n));
    const [patched, applied] = dmp.patch_apply(dmp.patch_make(render(base), render(next)), slice(src, orig));
    if (applied.every(Boolean)) { ctx.keptLossy = true; return patched; }
  }

  if (orig.type === 'table' && a.length === 1 && b.length > 1) {
    // A table with only a header row: new rows go after the delimiter row ('|--|--|').
    const header = writeNode(a[0], b[0], ctx, orig, baseKids?.[0]);
    const delimiter = src.slice(a[0].position!.end.offset, orig.position!.end.offset);
    return src.slice(orig.position!.start.offset, a[0].position!.start.offset) + header + delimiter
      + b.slice(1).map(row => '\n' + serialiseNew(row, orig, src)).join('');
  }

  let pre = 0;
  while (pre < a.length && pre < b.length && eq(pre, pre)) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && eq(a.length - 1 - suf, b.length - 1 - suf)) suf++;
  const gapAfter = (i: number) => src.slice(a[i].position!.end.offset, a[i + 1].position!.start.offset);
  // Separator for new children: the last original gap (a table's first gap is its delimiter row).
  const defaultGap = INLINE.has(a[0].type) ? ''
    : a.length > 2 || (a.length === 2 && orig.type !== 'table') ? gapAfter(a.length - 2)
    : orig.type === 'root' ? '\n\n' : '\n';
  // map[i] = index of the original child that child i of `next` derives from, or -1 when it is new.
  const midA = a.length - pre - suf;
  const map = b.map((_, i) => (i < pre ? i : i >= b.length - suf ? a.length - (b.length - i) : i - pre < midA ? i : -1));
  let out = src.slice(orig.position!.start.offset, a[0].position!.start.offset);
  for (let i = 0; i < b.length; i++) {
    const j = map[i];
    out += j >= 0 ? writeNode(a[j], b[i], ctx, orig, baseKids?.[j]) : serialiseNew(b[i], orig, src);
    if (i < b.length - 1) out += j >= 0 && map[i + 1] === j + 1 ? gapAfter(j) : defaultGap;
  }
  return out + src.slice(a[a.length - 1].position!.end.offset, orig.position!.end.offset);
}

/// Merge the editor's Markdown into the document: unchanged parts keep their exact original bytes.
/// `base` = the editor's Markdown for `src` before the user's edits (see `writeNode`).
/// `accept` checks a candidate source: it must load in the editor as exactly `edited` (the webview
/// passes its own parser/serialiser). Candidates: fine-grained, whole changed blocks, full rewrite.
export function mergeIntoSource(src: string, edited: string, base?: string, accept?: (candidate: string) => boolean): string {
  // The editor speaks LF; a CRLF page is merged as LF and converted back.
  if (src.includes('\r\n')) {
    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
    const lfAccept = accept && ((c: string) => accept(crlf(c)));
    return crlf(mergeIntoSource(src.replace(/\r\n/g, '\n'), edited, base, lfAccept));
  }
  const orig = parseAdo(src);
  const next = parseAdo(edited);
  if (!orig.children?.length) return edited;
  const root = { ...orig, position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: src.length } } };
  const baseTree = base === undefined ? undefined : parseAdo(base);
  for (const coarse of [false, true]) {
    const ctx: WriteContext = { src, coarse, keptLossy: false };
    const out = writeNode(root, next, ctx, null, baseTree);
    if (accept ? accept(out) : ctx.keptLossy || same(parseAdo(out), next)) return out;
  }
  return edited;
}

/// True when two Markdown texts have the same content (formatting such as '*' vs '_' aside).
export function sameMarkdown(a: string, b: string): boolean {
  return same(parseAdo(a), parseAdo(b));
}
