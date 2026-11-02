# Changelog

## 0.6.2

Pages now look like they do in the Azure DevOps wiki:

- A line break inside a paragraph shows as a new line.
- Placeholders in angle brackets such as `<Application>` or `<TODO>` show as text instead of an HTML tag.
- `[[_TOSP_]]` shows the child pages of the page, in wiki order.
- Tags show as cards in a box; long values no longer overlap.
- Compact lists, check boxes for task lists, a bulleted table of contents, e-mail addresses as plain
  text and HTML comments as a small muted line.
- Headings such as `##3. Title` (no space, starting with a digit) and `[[_TOC_]]` and `[[_TOSP_]]`
  on consecutive lines are recognised.

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
