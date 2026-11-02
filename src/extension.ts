// Extension host: registers the custom editor for wiki pages and keeps the text document in sync
// with the webview. The webview does the Markdown merge; the host only applies text edits.
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { git, createPage, loadTree, type WikiPage } from './wiki';
import { WikiLocation, WikiTreeProvider } from './sidebar';
import { publish } from './publish';
import { findPage, searchText } from './search';
import { pullWiki } from './pull';

const t = vscode.l10n.t;
const VIEW_TYPE = 'scalpel.editor';
const location = new WikiLocation();
/// Open editors by file (lower case path), and text to select once a page has loaded.
const openWebviews = new Map<string, vscode.Webview>();
const pendingReveal = new Map<string, string>();

/// Open a page in the editor; optionally select the first occurrence of `reveal`.
function openPage(wikiRoot: string, relative: string, reveal?: string) {
  const file = path.join(wikiRoot, ...relative.split('/'));
  const key = file.toLowerCase();
  if (reveal) pendingReveal.set(key, reveal);
  vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), VIEW_TYPE).then(() => {
    const webview = openWebviews.get(key);
    const text = pendingReveal.get(key);
    if (webview && text) { pendingReveal.delete(key); webview.postMessage({ type: 'reveal', text }); }
  });
}

export function activate(context: vscode.ExtensionContext) {
  const tree = new WikiTreeProvider(location);
  const wikiRootOrAsk = async () => location.root ?? (await chooseWiki());
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new WikiEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerTreeDataProvider('scalpel.pages', tree),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('scalpel.wikiPath')) tree.refresh(); }),
    vscode.commands.registerCommand('scalpel.refreshPages', () => tree.refresh()),
    vscode.commands.registerCommand('scalpel.chooseWiki', () => chooseWiki()),
    vscode.commands.registerCommand('scalpel.openPage', (page: WikiPage) => {
      const root = location.root;
      if (root) openLink(`/${page.relative}`, root);
    }),
    vscode.commands.registerCommand('scalpel.newPage', async (parent?: WikiPage) => {
      const root = await wikiRootOrAsk();
      if (!root) return;
      const title = await vscode.window.showInputBox({
        title: parent ? t('New subpage under "{0}"', parent.title) : t('New page'),
        prompt: t('Page title'),
        validateInput: v => (v.trim() ? undefined : t('Enter a title')),
      });
      if (!title) return;
      try {
        const file = createPage(root, parent?.relative, title, t);
        tree.refresh();
        vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), VIEW_TYPE);
      } catch (error) {
        vscode.window.showErrorMessage((error as Error).message);
      }
    }),
    vscode.commands.registerCommand('scalpel.findPage', async () => {
      const root = await wikiRootOrAsk();
      if (root) await findPage(root, (relative, reveal) => openPage(root, relative, reveal));
    }),
    vscode.commands.registerCommand('scalpel.searchText', async () => {
      const root = await wikiRootOrAsk();
      if (root) await searchText(root, (relative, reveal) => openPage(root, relative, reveal));
    }),
    vscode.commands.registerCommand('scalpel.pull', async () => {
      const root = await wikiRootOrAsk();
      if (root) { await pullWiki(root); tree.refresh(); }
    }),
    vscode.commands.registerCommand('scalpel.publish', async () => {
      const root = await wikiRootOrAsk();
      if (root) { await publish(root); tree.refresh(); }
    }),
    vscode.commands.registerCommand('scalpel.openEditor', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    // Signed in (or out) elsewhere, e.g. via the Accounts menu: let open editors retry their images.
    vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === 'microsoft') signInWaiters.forEach(webview => webview.postMessage({ type: 'reloadImages' }));
    }),
    vscode.commands.registerCommand('scalpel.openSource', (uri?: vscode.Uri) => {
      const target = uri ?? activeCustomEditorUri();
      if (target) vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
  );

  // Fetch the latest wiki once when VS Code starts (setting scalpel.pullOnStartup, needs scalpel.wikiPath).
  const startupRoot = location.root;
  if (startupRoot && vscode.workspace.getConfiguration('scalpel').get<boolean>('pullOnStartup', true))
    pullWiki(startupRoot, true).then(() => tree.refresh());
}

export function deactivate() {}

function activeCustomEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

/// The wiki root: nearest folder (upwards) with '.git', else with '.attachments'.
function findWikiRoot(file: string): string {
  for (const marker of ['.git', '.attachments']) {
    let dir = path.dirname(file);
    for (;;) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.dirname(file);
}

/// Let the user pick the wiki clone; stored in the 'scalpel.wikiPath' setting.
async function chooseWiki(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: t('Choose the folder of the wiki clone') });
  const folder = picked?.[0]?.fsPath;
  if (!folder) return undefined;
  if (!fs.existsSync(path.join(folder, '.git'))) {
    vscode.window.showWarningMessage(t('This folder is not a git clone of a wiki.'));
    return undefined;
  }
  await vscode.workspace.getConfiguration('scalpel').update('wikiPath', folder, vscode.ConfigurationTarget.Global);
  return folder;
}

class WikiEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const wikiRoot = findWikiRoot(document.uri.fsPath);
    location.noteOpened(wikiRoot);
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.file(wikiRoot)],
    };
    webview.html = this.html(webview);

    /// Text we wrote ourselves; its change event must not be echoed back to the webview.
    let ownText: string | undefined;

    const changes = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() !== document.uri.toString() || event.contentChanges.length === 0) return;
      const text = document.getText();
      if (text === ownText) return;
      // Ctrl+Z/Ctrl+Y in the webview reach VS Code, which undoes on this text document.
      const reason = event.reason === vscode.TextDocumentChangeReason.Undo ? 'undo'
        : event.reason === vscode.TextDocumentChangeReason.Redo ? 'redo' : 'external';
      webview.postMessage({ type: 'external', text, reason });
    });
    signInWaiters.add(webview);
    const key = document.uri.fsPath.toLowerCase();
    openWebviews.set(key, webview);
    panel.onDidDispose(() => { changes.dispose(); signInWaiters.delete(webview); openWebviews.delete(key); });

    webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'ready':
          webview.postMessage({
            type: 'load',
            text: document.getText(),
            mermaidUrl: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'mermaid.min.js')).toString(),
          });
          if (pendingReveal.has(key)) {
            webview.postMessage({ type: 'reveal', text: pendingReveal.get(key) });
            pendingReveal.delete(key);
          }
          break;
        case 'image':
          webview.postMessage({ type: 'image', id: message.id, url: await resolveImage(String(message.src), wikiRoot, webview) });
          break;
        case 'edit':
          ownText = message.text;
          await replaceText(document, message.text);
          break;
        case 'openSource':
          vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        case 'publish':
          vscode.commands.executeCommand('scalpel.publish');
          break;
        case 'openLink':
          openLink(String(message.href ?? ''), wikiRoot);
          break;
        case 'saveAttachment':
          webview.postMessage({ type: 'attachmentSaved', id: message.id, path: saveAttachment(wikiRoot, String(message.mime), String(message.data)) });
          break;
        case 'lookup': {
          const value = message.kind === 'subpages'
            ? await subpages(wikiRoot, document.uri.fsPath)
            : await adoLookup(String(message.kind), String(message.key), wikiRoot);
          webview.postMessage({ type: 'lookup', kind: message.kind, key: message.key, value });
          break;
        }
        case 'openWorkitem': {
          const context = await adoContext(wikiRoot);
          if (context && /^\d+$/.test(String(message.id)))
            vscode.env.openExternal(vscode.Uri.parse(`https://dev.azure.com/${encodeURIComponent(context.org)}/${encodeURIComponent(context.project)}/_workitems/edit/${message.id}`));
          break;
        }
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`, // cspSource: mermaid.min.js, loaded on demand
    ].join('; ');
    const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const button = (action: string, label: string, title: string) =>
      `<button data-action="${action}" title="${escape(title)}">${label}</button>`;
    // the webview's own strings are translated from the same bundle (see webview/l10n.ts)
    const l10n = escape(JSON.stringify(vscode.l10n.bundle ?? {}));
    return `<!doctype html>
<html lang="${escape(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Scalpel</title>
</head>
<body data-l10n="${l10n}">
<div id="toolbar">
  ${button('bold', '<b>B</b>', t('Bold (Ctrl+B)'))}
  ${button('italic', '<i>I</i>', t('Italic (Ctrl+I)'))}
  ${button('strike', '<s>S</s>', t('Strikethrough'))}
  ${button('code', '&lt;/&gt;', t('Inline code'))}
  <span class="sep"></span>
  ${button('h1', 'H1', t('Heading 1'))}
  ${button('h2', 'H2', t('Heading 2'))}
  ${button('h3', 'H3', t('Heading 3'))}
  ${button('text', '¶', t('Normal text'))}
  <span class="sep"></span>
  ${button('bullet', '•', t('Bulleted list'))}
  ${button('ordered', '1.', t('Numbered list'))}
  ${button('quote', '❝', t('Quote'))}
  ${button('codeblock', '{ }', t('Code block'))}
  <span class="sep"></span>
  ${button('table', '▦', t('Insert table'))}
  ${button('addRow', escape(t('+row')), t('Add row'))}
  ${button('addCol', escape(t('+col')), t('Add column'))}
  ${button('delRow', escape(t('−row')), t('Delete row'))}
  ${button('delCol', escape(t('−col')), t('Delete column'))}
  <span class="sep"></span>
  ${button('source', 'Markdown', t('Open as Markdown text'))}
  ${button('publish', escape(t('Publish')), t('Publish changes to the wiki (commit and push, live immediately)'))}
  <span id="status"></span>
</div>
<div id="editor"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

/// Replace the document text with one minimal edit (common prefix/suffix kept), so undo and
/// dirty-tracking behave as if the user typed the change.
async function replaceText(document: vscode.TextDocument, text: string) {
  const old = document.getText();
  if (old === text) return;
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  let end = 0;
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(old.length - end)), text.slice(start, text.length - end));
  await vscode.workspace.applyEdit(edit);
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp',
};

/// Webview URL for a wiki image: the file on disk, or (sparse checkout) its blob from git as data URL.
async function resolveImage(src: string, wikiRoot: string, webview: vscode.Webview): Promise<string | null> {
  if (ADO_URL.test(src)) return fetchAdoImage(src);
  const relative = safeDecode(src.split(/[?#]/)[0]).replace(/^\/+/, '');
  const file = path.join(wikiRoot, ...relative.split('/'));
  if (fs.existsSync(file)) return webview.asWebviewUri(vscode.Uri.file(file)).toString();
  const blob = await git(wikiRoot, ['show', `HEAD:${relative}`]).catch(() => null);
  return blob ? `data:${MIME[path.extname(relative).toLowerCase()] ?? 'application/octet-stream'};base64,${blob.toString('base64')}` : null;
}

// ---- images hosted by Azure DevOps (work item attachments) -------------------------------------
// They need a signed-in request. We use VS Code's own Microsoft sign-in (scope: Azure DevOps);
// VS Code stores the session, the extension keeps no secrets.

const ADO_URL = /^https:\/\/(dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)\//i;
const ADO_SCOPES = ['499b84ac-1321-427f-aa17-267ca6975798/.default'];
/// Webviews to tell when the user has signed in, so they can load the images again.
const signInWaiters = new Set<vscode.Webview>();
let signInOffered = false;

/// Signed-in fetch to Azure DevOps; undefined when not signed in (the user is offered a sign-in).
async function adoFetch(url: string, accept = 'application/json'): Promise<Response | undefined> {
  const session = await vscode.authentication.getSession('microsoft', ADO_SCOPES, { silent: true }).then(s => s, () => undefined);
  if (!session) {
    offerSignIn();
    return undefined;
  }
  return fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}`, Accept: accept } });
}

/// Organisation and project of the wiki, from its git remote ('https://dev.azure.com/<org>/<project>/_git/...').
const adoContexts = new Map<string, Promise<{ org: string; project: string } | undefined>>();
function adoContext(wikiRoot: string) {
  let context = adoContexts.get(wikiRoot);
  if (!context) {
    context = git(wikiRoot, ['remote', 'get-url', 'origin']).then(out => {
      const url = out.toString().trim();
      const m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\//.exec(url) ?? /\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\//.exec(url);
      return m ? { org: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]) } : undefined;
    }, () => undefined);
    adoContexts.set(wikiRoot, context);
  }
  return context;
}

/// Sub pages of a page for '[[_TOSP_]]', as JSON [{title, href, children}] in wiki order.
async function subpages(wikiRoot: string, file: string): Promise<string> {
  const relative = path.relative(wikiRoot, file).split(path.sep).join('/');
  const find = (pages: WikiPage[]): WikiPage | undefined => {
    for (const page of pages) {
      if (page.relative.toLowerCase() === relative.toLowerCase()) return page;
      const found = find(page.children);
      if (found) return found;
    }
    return undefined;
  };
  const list = (pages: WikiPage[]): unknown[] =>
    pages.map(p => ({ title: p.title, href: `/${p.relative.slice(0, -3)}`, children: list(p.children) }));
  return JSON.stringify(list(find(await loadTree(wikiRoot))?.children ?? []));
}

/// Person name for a mention GUID, or work item {type, title, state} as JSON. Cached per session.
const lookups = new Map<string, Promise<string | null>>();
function adoLookup(kind: string, key: string, wikiRoot: string): Promise<string | null> {
  const id = `${kind}:${key.toLowerCase()}`;
  let result = lookups.get(id);
  if (!result) {
    result = (async () => {
      const context = await adoContext(wikiRoot);
      if (!context) return null;
      const org = encodeURIComponent(context.org);
      if (kind === 'identity' && /^[0-9a-f-]{36}$/i.test(key)) {
        const response = await adoFetch(`https://vssps.dev.azure.com/${org}/_apis/identities?identityIds=${key}&api-version=7.1`);
        if (!response?.ok) return null;
        const identity = (await response.json()).value?.[0];
        return identity?.customDisplayName || identity?.providerDisplayName || null;
      }
      if (kind === 'workitem' && /^\d+$/.test(key)) {
        const response = await adoFetch(`https://dev.azure.com/${org}/_apis/wit/workitems/${key}?fields=System.Title,System.WorkItemType,System.State&api-version=7.1`);
        if (!response?.ok) return null;
        const fields = (await response.json()).fields ?? {};
        return JSON.stringify({ type: fields['System.WorkItemType'], title: fields['System.Title'], state: fields['System.State'] });
      }
      return null;
    })().catch(() => null);
    lookups.set(id, result);
    // a failed lookup (e.g. not signed in yet) may be retried later
    result.then(value => { if (value === null) lookups.delete(id); });
  }
  return result;
}

async function fetchAdoImage(url: string): Promise<string | null> {
  try {
    const response = await adoFetch(url, '*/*');
    if (!response) return null;
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) return null;
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

/// Ask once per VS Code session; after signing in every open editor reloads its images.
async function offerSignIn() {
  if (signInOffered) return;
  signInOffered = true;
  const signIn = t('Sign in');
  const choice = await vscode.window.showInformationMessage(
    t('This page shows images, names or work items from Azure DevOps. Sign in with your Microsoft account to show them.'), signIn);
  if (choice !== signIn) return;
  const session = await vscode.authentication.getSession('microsoft', ADO_SCOPES, { createIfNone: true }).then(s => s, () => undefined);
  if (session) signInWaiters.forEach(webview => webview.postMessage({ type: 'reloadImages' }));
}

const EXTENSION_FOR: Record<string, string> = Object.fromEntries(Object.entries(MIME).map(([ext, mime]) => [mime, ext]));

/// Store a pasted image like ADO does: '<wiki>/.attachments/image-<guid>.<ext>'. Returns the wiki path.
function saveAttachment(wikiRoot: string, mime: string, base64: string): string | null {
  const ext = EXTENSION_FOR[mime];
  if (!ext || !base64) return null;
  const name = `image-${crypto.randomUUID()}${ext === '.jpeg' ? '.jpg' : ext}`;
  try {
    fs.mkdirSync(path.join(wikiRoot, '.attachments'), { recursive: true });
    fs.writeFileSync(path.join(wikiRoot, '.attachments', name), Buffer.from(base64, 'base64'));
    return `/.attachments/${name}`;
  } catch {
    return null;
  }
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/// Page file for a wiki link. ADO keeps '%2D' (and other ASCII escapes such as '%3A') in file names
/// but stores non-ASCII characters as-is: '/A/Pati%C3%ABnt' is the file 'A/Patiënt.md'.
function wikiPageFile(href: string, wikiRoot: string): { file: string; relative: string } {
  const pathPart = href.split(/[?#]/)[0].replace(/^\/+/, '').replace(/\.md$/, '');
  const relative = pathPart.replace(/(%[89A-F][0-9A-F])+/gi, seq => safeDecode(seq));
  return { file: path.join(wikiRoot, ...relative.split('/')) + '.md', relative: `${relative}.md` };
}

/// Wiki links ('/Map/Pagina') open the page file in this editor; other links open externally.
async function openLink(href: string, wikiRoot: string) {
  if (!href) return;
  if (/^[a-z]+:/i.test(href)) {
    vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const { file, relative } = wikiPageFile(href, wikiRoot);
  if (fs.existsSync(file)) {
    vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), VIEW_TYPE);
    return;
  }
  const inGit = (await git(wikiRoot, ['ls-tree', '--name-only', 'HEAD', '--', relative]).catch(() => Buffer.alloc(0))).length > 0;
  if (!inGit) {
    vscode.window.showWarningMessage(t('Wiki page not found: {0}', relative));
    return;
  }
  const add = t('Add to checkout');
  const choice = await vscode.window.showInformationMessage(
    t('The page is in the wiki but not in your sparse checkout: {0}', relative), add);
  if (choice !== add) return;
  await git(wikiRoot, ['sparse-checkout', 'add', relative]);
  if (fs.existsSync(file)) vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), VIEW_TYPE);
  else vscode.window.showWarningMessage(t('Adding to the checkout failed: {0}', relative));
}
