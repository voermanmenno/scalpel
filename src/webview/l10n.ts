// Translations for the webview. The host puts VS Code's l10n bundle for the display language in
// <body data-l10n>; strings are English and are their own key (as with vscode.l10n.t).
let bundle: Record<string, string> | undefined;

/// Translated text; '{0}', '{1}', ... are replaced by the arguments.
export function t(message: string, ...args: (string | number)[]): string {
  if (bundle === undefined) {
    try { bundle = JSON.parse(document.body?.dataset.l10n || '{}'); } catch { bundle = {}; }
  }
  const text = bundle![message] ?? message;
  return text.replace(/\{(\d+)\}/g, (match, index) => (args[Number(index)] !== undefined ? String(args[Number(index)]) : match));
}
