# Changelog

## 0.6.1

- Mermaid 12.2.0 (fixes a low-severity KaTeX advisory, GHSA-238p-pmpm-9mq7).
- New icon.

## 0.6.0

First public release as **Scalpel**.

- WYSIWYG editing of Azure DevOps wiki pages in a local git clone; only the Markdown you changed is
  written back, the rest of the file stays byte-for-byte the same.
- Azure DevOps wiki syntax: tag front matter, `[[_TOC_]]`, `::: mermaid` diagrams (with a zoomable
  viewer and a source editor with live preview), `@<GUID>` mentions and `#123` work items (names and
  titles after signing in), image sizes (`=600x`), inline HTML.
- Paste or drop images into the page (stored in `.attachments`, as Azure DevOps does).
- Side bar with the page tree in wiki order, new (sub)pages, find a page by title, search the text of
  all pages.
- Pull from the wiki (also on startup) and publish with one click, with *Undo* (git revert).
- English and Dutch.
