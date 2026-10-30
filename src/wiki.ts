// Wiki structure: page tree from git (includes pages outside a sparse checkout) ordered by '.order',
// page names <-> file names, and the git helper shared by the extension.
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';

export function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 }, (error, stdout, stderr) =>
      (error ? reject(new Error(stderr.toString().trim() || error.message)) : resolve(stdout))));
}

/// Page title from a file name: '-' is a space, '%2D' a dash, other escapes decoded ('Dwh009-%2D-ERP' -> 'Dwh009 - ERP').
export function pageTitle(fileName: string): string {
  const base = fileName.replace(/\.md$/, '');
  return base.replace(/-/g, ' ').replace(/(%[0-9A-F]{2})+/gi, seq => {
    try { return decodeURIComponent(seq); } catch { return seq; }
  });
}

/// File name (without '.md') for a page title, the way ADO names it.
export function pageFileName(title: string): string {
  let out = '';
  for (const ch of title.trim()) {
    if (ch === ' ') out += '-';
    else if (ch === '-') out += '%2D';
    else if (/[\\/:*?"<>|#%]/.test(ch)) out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    else out += ch;
  }
  return out;
}

/// Translates an English message with '{0}' placeholders (vscode.l10n.t in the extension).
export type Translate = (message: string, ...args: (string | number)[]) => string;
export const english: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (match, index) => (args[Number(index)] !== undefined ? String(args[Number(index)]) : match));

/// A changed file from 'git status --porcelain' (two-letter status, path).
export interface Change { status: string; file: string }

/// One-line commit message from the changed pages, e.g. 'Wiki: Release notes updated'.
export function commitMessage(list: Change[], t: Translate = english): string {
  const pages = list.filter(c => c.file.endsWith('.md'));
  if (!pages.length) return t('Wiki: attachments and order updated');
  const isNew = (c: Change) => c.status.includes('?') || c.status.includes('A');
  const isGone = (c: Change) => c.status.includes('D');
  const titles = pages.map(c => pageTitle(c.file.split('/').pop()!));
  const subject = titles.length === 1 ? titles[0]
    : titles.length <= 3 ? t('{0} and {1}', titles.slice(0, -1).join(', '), titles.at(-1)!)
    : t('{0} pages', titles.length);
  return pages.every(isNew) ? t('Wiki: {0} created', subject)
    : pages.every(isGone) ? t('Wiki: {0} deleted', subject)
    : t('Wiki: {0} updated', subject);
}

export interface WikiPage {
  /// path relative to the wiki root, with '/' ('Map/Pagina.md'); folders without own page have no file
  relative: string;
  title: string;
  hasFile: boolean;
  /// on disk (not just in git: a sparse checkout leaves pages out)
  onDisk: boolean;
  children: WikiPage[];
}

/// All pages of the wiki as a tree: git HEAD plus new, uncommitted pages.
export async function loadTree(wikiRoot: string): Promise<WikiPage[]> {
  const listed = (await git(wikiRoot, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).catch(() => Buffer.alloc(0))).toString().split('\0');
  const untracked = (await git(wikiRoot, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => Buffer.alloc(0))).toString().split('\0');
  const files = new Set([...listed, ...untracked].filter(Boolean));

  const nodes = new Map<string, WikiPage>();
  const node = (relativeNoExt: string): WikiPage => {
    let page = nodes.get(relativeNoExt);
    if (!page) {
      page = { relative: `${relativeNoExt}.md`, title: pageTitle(relativeNoExt.split('/').pop()!), hasFile: false, onDisk: false, children: [] };
      nodes.set(relativeNoExt, page);
      const parent = relativeNoExt.includes('/') ? node(relativeNoExt.slice(0, relativeNoExt.lastIndexOf('/'))) : undefined;
      (parent?.children ?? roots).push(page);
    }
    return page;
  };
  const roots: WikiPage[] = [];
  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('.')) continue;
    const page = node(file.slice(0, -3));
    page.hasFile = true;
  }
  for (const page of nodes.values()) page.onDisk = fs.existsSync(path.join(wikiRoot, ...page.relative.split('/')));

  // order: '.order' of the folder (from disk, else from git), then alphabetical
  const orderOf = async (folder: string): Promise<string[]> => {
    const file = folder ? `${folder}/.order` : '.order';
    if (!files.has(file)) return [];
    const onDisk = path.join(wikiRoot, ...file.split('/'));
    const text = fs.existsSync(onDisk) ? fs.readFileSync(onDisk, 'utf8') : (await git(wikiRoot, ['show', `HEAD:${file}`]).catch(() => Buffer.alloc(0))).toString();
    return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  };
  const sort = async (list: WikiPage[], folder: string) => {
    const order = await orderOf(folder);
    const rank = (p: WikiPage) => { const i = order.indexOf(p.relative.slice(0, -3).split('/').pop()!); return i < 0 ? order.length : i; };
    list.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
    for (const page of list) await sort(page.children, page.relative.slice(0, -3));
  };
  await sort(roots, '');
  return roots;
}

/// Create a sub page (or top-level page when parent is undefined): the file, its folder and the '.order' line.
export function createPage(wikiRoot: string, parentRelative: string | undefined, title: string, t: Translate = english): string {
  const folder = parentRelative ? parentRelative.replace(/\.md$/, '') : '';
  const name = pageFileName(title);
  const dir = path.join(wikiRoot, ...folder.split('/').filter(Boolean));
  const file = path.join(dir, `${name}.md`);
  if (fs.existsSync(file)) throw new Error(t('The page already exists: {0}', title));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `# ${title}\n`);
  const order = path.join(dir, '.order');
  const current = fs.existsSync(order) ? fs.readFileSync(order, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(order, current === '' ? name : current.replace(/(\r?\n)?$/, `${eol}${name}`));
  return file;
}
