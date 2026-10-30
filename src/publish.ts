// Publish the wiki clone with one click: save, commit everything with a generated one-line message,
// pull --rebase and push. A push to the wiki branch is live immediately; the notification offers
// 'Undo', which reverts the published commits and pushes that (version control is the net).
import * as vscode from 'vscode';
import { git, commitMessage, type Change } from './wiki';

const t = vscode.l10n.t;

async function changes(wikiRoot: string): Promise<Change[]> {
  const out = (await git(wikiRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString();
  const entries = out.split('\0').filter(Boolean);
  const result: Change[] = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    result.push({ status, file: entries[i].slice(3) });
    if (status.startsWith('R')) i++; // rename: next entry is the old path
  }
  return result;
}

const branchOf = async (wikiRoot: string) => (await git(wikiRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).toString().trim();
const sha = async (wikiRoot: string, ref: string) => (await git(wikiRoot, ['rev-parse', ref])).toString().trim();

export async function publish(wikiRoot: string) {
  for (const document of vscode.workspace.textDocuments)
    if (document.isDirty && document.uri.fsPath.toLowerCase().startsWith(wikiRoot.toLowerCase())) await document.save();

  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Publishing the wiki') }, async progress => {
      const branch = await branchOf(wikiRoot);
      const list = await changes(wikiRoot);
      let message: string | undefined;
      if (list.length) {
        message = commitMessage(list, t);
        progress.report({ message: t('committing') });
        await git(wikiRoot, ['add', '-A']);
        await git(wikiRoot, ['commit', '-m', message]);
      }
      progress.report({ message: t('pulling the latest version') });
      await git(wikiRoot, ['pull', '--rebase', '--autostash', 'origin', branch]);
      const remoteBefore = await sha(wikiRoot, `origin/${branch}`);
      const ahead = Number((await git(wikiRoot, ['rev-list', '--count', `origin/${branch}..HEAD`])).toString().trim());
      if (!ahead) return undefined;
      // also earlier commits whose push failed
      message ??= (await git(wikiRoot, ['log', '-1', '--format=%s'])).toString().trim();
      progress.report({ message: t('pushing to {0}', branch) });
      await git(wikiRoot, ['push', 'origin', `HEAD:${branch}`]);
      return { branch, message, ahead, from: remoteBefore, to: await sha(wikiRoot, 'HEAD') };
    });

    if (!result) {
      vscode.window.showInformationMessage(t('There are no changes to publish.'));
      return;
    }
    const undo = t('Undo');
    const text = result.ahead > 1 ? t('Published: {0} ({1} commits)', result.message, result.ahead) : t('Published: {0}', result.message);
    const answer = await vscode.window.showInformationMessage(text, undo);
    if (answer === undo) await revert(wikiRoot, result.branch, result.from, result.to);
  } catch (error) {
    vscode.window.showErrorMessage(t('Publishing failed.'), {
      modal: true,
      detail: `${(error as Error).message}\n\n${t('A commit that was already made stays local; the next Publish pushes it. On a conflict: Source Control.')}`,
    });
  }
}

/// Undo a publication: revert the published commits (from..to) as a new commit and push it.
async function revert(wikiRoot: string, branch: string, from: string, to: string) {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Reverting the publication') }, async () => {
      await git(wikiRoot, ['pull', '--rebase', '--autostash', 'origin', branch]);
      await git(wikiRoot, ['revert', '--no-edit', `${from}..${to}`]);
      await git(wikiRoot, ['push', 'origin', `HEAD:${branch}`]);
    });
    vscode.window.showInformationMessage(t('The publication was reverted; the previous version is back in the wiki.'));
  } catch (error) {
    vscode.window.showErrorMessage(t('Reverting failed.'), {
      modal: true,
      detail: `${(error as Error).message}\n\n${t('Check Source Control; "git revert --abort" cancels a half-finished revert.')}`,
    });
  }
}
