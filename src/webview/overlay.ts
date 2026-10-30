// Full-window overlays outside the ProseMirror DOM: a zoomable diagram viewer and a source editor
// with live preview. (A textarea inside ProseMirror's non-editable atoms shows no caret in Chromium.)
import { t } from './l10n';

/// Open an overlay; returns a function that closes it. Esc closes it as well.
function openOverlay(title: string, body: HTMLElement, actions: HTMLElement[] = [], onClose?: () => void): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'ado-overlay';
  const header = document.createElement('div');
  header.className = 'ado-overlay-header';
  const heading = document.createElement('span');
  heading.className = 'ado-overlay-title';
  heading.textContent = title;
  const close = button('✕', t('Close (Esc)'));
  header.append(heading, ...actions, close);
  body.classList.add('ado-overlay-body');
  overlay.append(header, body);
  document.body.append(overlay);

  const done = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(); }
  };
  close.onclick = done;
  document.addEventListener('keydown', onKey, true);
  return done;
}

export function button(label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'ado-overlay-button';
  b.textContent = label;
  b.title = title;
  return b;
}

/// Zoom controls for an SVG diagram inside a scrolling container. Starts at real size (100%).
export function zoomable(container: HTMLElement): { controls: HTMLElement; update: () => void } {
  let scale = 1;
  let fit = false;
  const label = document.createElement('span');
  label.className = 'ado-zoom-label';
  const apply = () => {
    const svg = container.querySelector('svg');
    if (!svg) return;
    const width = svg.viewBox?.baseVal?.width || svg.getBoundingClientRect().width;
    svg.removeAttribute('width');
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    const effective = fit ? Math.min(1, (container.clientWidth - 24) / width) : scale;
    svg.style.width = `${Math.round(width * effective)}px`;
    label.textContent = fit ? t('Fit') : `${Math.round(scale * 100)}%`;
  };
  const set = (next: number) => { fit = false; scale = Math.min(4, Math.max(0.25, next)); apply(); };
  const minus = button('−', t('Smaller (Ctrl+scroll wheel)'));
  const reset = button('100%', t('Actual size'));
  const plus = button('+', t('Larger (Ctrl+scroll wheel)'));
  const fitButton = button(t('Fit'), t('Fit to width'));
  minus.onclick = () => set(scale / 1.25);
  plus.onclick = () => set(scale * 1.25);
  reset.onclick = () => set(1);
  fitButton.onclick = () => { fit = true; apply(); };
  container.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    set(event.deltaY < 0 ? scale * 1.1 : scale / 1.1);
  }, { passive: false });
  const controls = document.createElement('span');
  controls.className = 'ado-zoom';
  controls.append(minus, label, plus, reset, fitButton);
  return { controls, update: apply };
}

/// Show a rendered diagram (its SVG markup) at real size with zoom.
export function openDiagramViewer(svgMarkup: string) {
  const body = document.createElement('div');
  const canvas = document.createElement('div');
  canvas.className = 'ado-zoom-canvas';
  canvas.innerHTML = svgMarkup;
  body.append(canvas);
  const { controls, update } = zoomable(canvas);
  openOverlay('Diagram', body, [controls]);
  update();
}

/// Edit an atom's source in a large textarea; `render` (optional) draws a live preview of the text.
export function openSourceEditor(options: {
  title: string;
  value: string;
  render?: (text: string, target: HTMLElement) => Promise<unknown>;
  onApply: (text: string) => void;
}) {
  const body = document.createElement('div');
  body.classList.add('ado-source-editor');
  const area = document.createElement('textarea');
  area.value = options.value;
  area.spellcheck = false;
  body.append(area);

  const actions: HTMLElement[] = [];
  let update = () => {};
  if (options.render) {
    body.classList.add('with-preview');
    const canvas = document.createElement('div');
    canvas.className = 'ado-zoom-canvas';
    body.append(canvas);
    const zoom = zoomable(canvas);
    actions.push(zoom.controls);
    let timer: ReturnType<typeof setTimeout> | undefined;
    update = () => { options.render!(area.value, canvas).then(zoom.update); };
    area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 400); });
  }

  const apply = button(t('Apply'), t('Apply (Ctrl+Enter)'));
  apply.classList.add('primary');
  actions.push(apply);
  const close = openOverlay(options.title, body, actions);
  apply.onclick = () => { if (area.value !== options.value) options.onApply(area.value); close(); };
  area.addEventListener('keydown', event => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Enter' && mod) { event.preventDefault(); apply.click(); }
    // VS Code catches Ctrl+Z/Ctrl+Y on the webview's window (bubble phase), blocks the browser's
    // undo and undoes the page document instead. Stop it here so the textarea's own undo works.
    if (mod && /^[zy]$/i.test(event.key)) event.stopPropagation();
  });
  update();
  area.focus();
  area.setSelectionRange(0, 0);
}
