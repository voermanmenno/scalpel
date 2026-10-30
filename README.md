# Scalpel – WYSIWYG for Azure DevOps Wiki

Edit Azure DevOps wiki pages in VS Code the way they look in the wiki, and type straight into them.
Scalpel works on a local git clone of the wiki. When you save, **only the piece of Markdown you
actually changed is rewritten**; the rest of the file stays byte-for-byte the same, so `git diff`
shows exactly your change and nothing else.

Most WYSIWYG Markdown editors re-serialise the whole page: tables get re-aligned, list markers change,
escapes appear, and Azure DevOps syntax (tags, `[[_TOC_]]`, `::: mermaid`, `@<mentions>`) breaks.
Scalpel is tested against a real wiki of almost 800 pages: every page opens and saves unchanged, and
a typical edit changes exactly one line in the file.

## Getting started

1. Clone your wiki: in Azure DevOps open the wiki, choose **⋯ → Clone wiki**, and clone it with git.
2. Open a `.md` file of the clone and click the preview icon at the top right (**Open in Scalpel**),
   or right-click the file in the Explorer.
3. Edit the page. `Ctrl+S` saves as usual; the **Markdown** button opens the raw text.
4. Click **Publish** to put your changes live.

Choose the clone once with **Scalpel: Choose wiki folder** (setting `scalpel.wikiPath`); the side bar
and the pull on startup use it.

## Features

- **Wiki syntax as in Azure DevOps**: the tags table from the front matter, `[[_TOC_]]` as a clickable
  table of contents, `::: mermaid` diagrams, image sizes (`=600x`) and inline HTML such as
  `<span style="color:…">` and `<br>` in tables.
- **Diagrams**: *Enlarge* shows a diagram with zoom; double-click (or *Edit source*) opens a large
  source editor with a live preview next to it.
- **Mentions and work items**: `@<GUID>` shows the person's name and `#123456` the work item's title.
  `Ctrl+click` opens links, wiki pages and work items. For names, titles and images stored as work item
  attachments, VS Code asks once to sign in with your Microsoft account.
- **Images**: pasted or dropped images are stored as `.attachments/image-<guid>.png`, like Azure DevOps
  does.
- **Undo**: `Ctrl+Z` and `Ctrl+Y` work as in any VS Code editor.
- **Side bar**: the page tree in wiki order (`.order`), including pages outside a sparse checkout, and
  new (sub)pages with the file name and `.order` entry Azure DevOps expects.
- **Search**: *Find page* (`Ctrl+Alt+W`) by title or path; *Search the wiki* (`Ctrl+Alt+Shift+W`) in the
  text of all pages, opening the page with the hit selected.
- **Pull** (`git pull --rebase --autostash`) from the side bar, and automatically when VS Code starts
  (setting `scalpel.pullOnStartup`).
- **Publish with one click**: save, commit everything with a generated one-line message ("Wiki: <page>
  updated"), pull and push. A push to the wiki branch is live immediately. The notification afterwards
  offers **Undo**, which reverts the publication with `git revert` and pushes that. If a push fails, the
  commit stays local and the next Publish pushes it.
- **Languages**: English and Dutch, following VS Code's display language.

If the status bar of the editor says *"Note: this change rewrites the formatting of the whole page"*,
check the diff before you publish.

## Requirements

- VS Code 1.100 or later and git on the `PATH`.
- A git clone of an Azure DevOps wiki (`dev.azure.com` or `*.visualstudio.com`). Signing in is only
  needed for names, work item titles and work item attachment images.

## Development

```
npm install
npm run build       # dist/extension.cjs + dist/webview.js
npm run typecheck
npm test            # unit tests
npm run corpus -- <path to a wiki clone>   # open, edit and write back every page of a wiki
npm run package     # scalpel-<version>.vsix
```

`F5` starts an Extension Development Host (it opens the folder in `SCALPEL_WIKI`, if set).
`test/harness.html`, served by a local web server, runs the webview in a browser; fill it with
`node test/harness-page.mjs <part of the page path> <wiki clone>`.

### How the minimal diff works

`src/core/markdown.ts`: the source is parsed with remark, with the Azure DevOps dialect (`#Heading`
without a space, `:::` containers and macros as atoms). On every change `mergeIntoSource` compares
three trees: the source, the editor's rendering before the change (*base*) and after it. Whatever you
did not touch keeps its original bytes; only the smallest changed node is written again. The editor's
own parser checks every result; if that fails, the merge falls back to rewriting the changed block, and
only as a last resort the whole page.

## License

[MIT](LICENSE) © App-Men. Azure DevOps is a trademark of Microsoft; Scalpel is not affiliated with
Microsoft.
