// 'Scalpel' side bar: the page tree of the wiki clone, in wiki order.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { loadTree, type WikiPage } from './wiki';

/// The wiki clone: setting 'scalpel.wikiPath', else the wiki of the last page opened in the editor.
export class WikiLocation {
  private lastOpened: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  get root(): string | undefined {
    const configured = vscode.workspace.getConfiguration('scalpel').get<string>('wikiPath')?.trim();
    if (configured && fs.existsSync(configured)) return configured;
    return this.lastOpened;
  }

  /// Called when a page is opened in the editor (its wiki becomes the fallback location).
  noteOpened(wikiRoot: string) {
    if (this.lastOpened === wikiRoot) return;
    this.lastOpened = wikiRoot;
    this.changed.fire();
  }
}

export class WikiTreeProvider implements vscode.TreeDataProvider<WikiPage> {
  private readonly changed = new vscode.EventEmitter<WikiPage | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: Promise<WikiPage[]> | undefined;

  constructor(private readonly location: WikiLocation) {
    location.onDidChange(() => this.refresh());
  }

  refresh() {
    this.roots = undefined;
    this.changed.fire(undefined);
  }

  getChildren(page?: WikiPage): Promise<WikiPage[]> | WikiPage[] {
    if (page) return page.children;
    const root = this.location.root;
    if (!root) return [];
    this.roots ??= loadTree(root);
    return this.roots;
  }

  getTreeItem(page: WikiPage): vscode.TreeItem {
    const item = new vscode.TreeItem(page.title, page.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = page.relative;
    item.tooltip = page.relative;
    item.contextValue = 'wikiPage';
    if (!page.hasFile) {
      item.iconPath = new vscode.ThemeIcon('folder');
    } else if (!page.onDisk) {
      item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('disabledForeground'));
      item.description = vscode.l10n.t('not in checkout');
    } else {
      item.iconPath = new vscode.ThemeIcon('file');
    }
    if (page.hasFile) item.command = { command: 'scalpel.openPage', title: vscode.l10n.t('Open'), arguments: [page] };
    return item;
  }
}
