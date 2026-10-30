// Find a wiki page by title, or search the text of all pages (git grep on the working tree).
import * as vscode from 'vscode';
import { git, loadTree, pageTitle, type WikiPage } from './wiki';

const t = vscode.l10n.t;

interface PageItem extends vscode.QuickPickItem { page: WikiPage }
interface HitItem extends vscode.QuickPickItem { relative: string; text: string }

/// Quick pick over all page titles; the path (as titles) is shown and searchable too.
export async function findPage(wikiRoot: string, open: (relative: string, reveal?: string) => void) {
  const items: PageItem[] = [];
  const walk = (list: WikiPage[], trail: string[]) => {
    for (const page of list) {
      if (page.hasFile) items.push({ page, label: page.title, description: trail.join(' › '), iconPath: new vscode.ThemeIcon(page.onDisk ? 'file' : 'cloud') });
      walk(page.children, [...trail, page.title]);
    }
  };
  walk(await loadTree(wikiRoot), []);
  const pick = await vscode.window.showQuickPick(items, {
    title: t('Find wiki page'),
    placeHolder: t('Type part of the title or path, for example "release notes" or "team onboarding"'),
    matchOnDescription: true,
  });
  if (pick) open(pick.page.relative);
}

/// Search the text of all pages; a hit opens the page with the cursor on the found text.
export async function searchText(wikiRoot: string, open: (relative: string, reveal?: string) => void) {
  const quickPick = vscode.window.createQuickPick<HitItem>();
  quickPick.title = t('Search the wiki');
  quickPick.placeholder = t('Search term (at least 3 characters), not case-sensitive');
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  quickPick.onDidChangeValue(value => {
    clearTimeout(timer);
    const term = value.trim();
    if (term.length < 3) { quickPick.items = []; return; }
    timer = setTimeout(async () => {
      const mine = ++generation;
      quickPick.busy = true;
      const hits = await grep(wikiRoot, term);
      if (mine !== generation) return;
      quickPick.items = hits;
      quickPick.busy = false;
    }, 250);
  });
  quickPick.onDidAccept(() => {
    const hit = quickPick.selectedItems[0];
    if (!hit) return;
    quickPick.hide();
    open(hit.relative, hit.text);
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

async function grep(wikiRoot: string, term: string): Promise<HitItem[]> {
  // fixed string, case-insensitive, Markdown only; tracked and new files
  const out = await git(wikiRoot, ['grep', '-n', '-I', '-i', '-F', '--untracked', '-z', '-e', term, '--', '*.md'])
    .catch(() => Buffer.alloc(0));
  const items: HitItem[] = [];
  const perPage = new Map<string, number>();
  for (const line of out.toString().split('\n')) {
    const [relative, lineNumber, ...rest] = line.split('\0');
    if (!relative || !rest.length) continue;
    const count = (perPage.get(relative) ?? 0) + 1;
    perPage.set(relative, count);
    if (count > 3 || items.length >= 200) continue; // at most three hits per page
    const parts = relative.replace(/\.md$/, '').split('/');
    const text = rest.join('\0').trim();
    items.push({
      relative,
      text: term,
      label: pageTitle(parts.at(-1)!),
      description: `${parts.slice(0, -1).map(pageTitle).join(' › ')}  ·  ${t('line {0}', lineNumber)}`,
      detail: text.length > 160 ? `${text.slice(0, 157)}…` : text,
      alwaysShow: true,
    });
  }
  return items;
}
