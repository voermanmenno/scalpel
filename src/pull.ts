// Fetch the latest wiki from Azure DevOps: 'git pull --rebase --autostash' on the wiki clone.
// Local, unpublished commits and changes end up on top of the new version.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { git, pageTitle } from './wiki';

const t = vscode.l10n.t;

/// `quiet`: the automatic pull at startup. It skips when wiki pages have unsaved changes and only
/// reports when pages came in or something went wrong.
export async function pullWiki(wikiRoot: string, quiet = false): Promise<void> {
  const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d.uri.fsPath.toLowerCase().startsWith(wikiRoot.toLowerCase()));
  if (dirty.length) {
    if (quiet) return;
    const save = t('Save and pull');
    const answer = await vscode.window.showWarningMessage(
      t('{0} wiki page(s) have unsaved changes. Save them first?', dirty.length), { modal: true }, save);
    if (answer !== save) return;
    for (const document of dirty) await document.save();
  }

  const run = async () => {
    const branch = (await git(wikiRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).toString().trim();
    const before = (await git(wikiRoot, ['rev-parse', 'HEAD'])).toString().trim();
    await git(wikiRoot, ['pull', '--rebase', '--autostash', 'origin', branch]);
    const changed = (await git(wikiRoot, ['diff', '--name-only', before, 'HEAD', '--', '*.md'])).toString().split('\n').filter(Boolean);
    return changed;
  };

  try {
    const changed = await vscode.window.withProgress(
      { location: quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: t('Pulling the wiki') }, run);
    if (!changed.length) {
      if (quiet) vscode.window.setStatusBarMessage(`$(check) ${t('Wiki is up to date')}`, 5000);
      else vscode.window.showInformationMessage(t('The wiki is already up to date.'));
      return;
    }
    const names = changed.slice(0, 5).map(f => pageTitle(f.split('/').pop()!)).join(', ');
    vscode.window.showInformationMessage(changed.length <= 5
      ? t('Wiki updated: {0} page(s) changed ({1}).', changed.length, names)
      : t('Wiki updated: {0} page(s) changed.', changed.length));
  } catch (error) {
    const gitPath = (name: string) => git(wikiRoot, ['rev-parse', '--git-path', name])
      .then(p => fs.existsSync(path.resolve(wikiRoot, p.toString().trim())), () => false);
    const rebasing = (await gitPath('rebase-merge')) || (await gitPath('rebase-apply'));
    vscode.window.showErrorMessage(t('Pulling the wiki failed.'), {
      modal: !quiet,
      detail: `${(error as Error).message}\n\n${rebasing ? t('This may be a conflict with your own changes. Resolve it in Source Control, or abort with "git rebase --abort".') : ''}`,
    });
  }
}
