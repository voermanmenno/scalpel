// Renders ADO '::: mermaid' blocks. mermaid.min.js is loaded on first use (URL from the host);
// without a URL (headless tests) nothing is rendered and the caller shows the source instead.
import { t } from './l10n';

let mermaidUrl = '';
let loading: Promise<any> | undefined;
let counter = 0;

export function setMermaidUrl(url: string) {
  mermaidUrl = url;
}

function isDark() {
  return document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
}

function loadMermaid(): Promise<any> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = mermaidUrl;
    script.onload = () => {
      const mermaid = (window as any).mermaid;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default' });
      resolve(mermaid);
    };
    script.onerror = () => reject(new Error(t('mermaid could not be loaded')));
    document.head.append(script);
  });
  return loading;
}

/// The diagram source inside an ADO container: '::: mermaid\n<source>\n:::' -> '<source>'.
export function mermaidSource(container: string): string {
  return container.replace(/^:::\s*mermaid[^\n]*\n?/, '').replace(/\n?[ \t]*:::[ \t]*$/, '');
}

const DIAGRAM_TYPES = ['sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'stateDiagram', 'erDiagram', 'gitGraph',
  'flowchart', 'graph', 'gantt', 'pie', 'journey', 'mindmap', 'timeline', 'quadrantChart', 'requirementDiagram'];

/// Leniency for what ADO's older mermaid accepts (display only, the page source is not changed):
/// a diagram keyword in the wrong case ('sequencediagram') and a ```mermaid fence inside the block.
function lenient(source: string): string {
  let text = source;
  if (/^\s*```\s*mermaid/.test(text)) text = text.replace(/^\s*```[^\n]*\n?/, '').replace(/\n\s*```\s*$/, '');
  const first = /^\s*(\S+)/.exec(text);
  const type = first && DIAGRAM_TYPES.find(t => t.toLowerCase() === first[1].toLowerCase());
  if (type && type !== first[1]) text = text.replace(first[1], type);
  return text;
}

/// Render into `target`. Returns false when mermaid is unavailable or the diagram has errors
/// (the error text is then shown in `target`).
export async function renderMermaid(source: string, target: HTMLElement): Promise<boolean> {
  if (!mermaidUrl) return false;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`ado-mermaid-${counter++}`, lenient(source));
    target.innerHTML = svg;
    return true;
  } catch (error) {
    const message = document.createElement('div');
    message.className = 'ado-mermaid-error';
    message.textContent = t('The diagram cannot be drawn: {0}', (error as Error).message ?? String(error));
    target.replaceChildren(message);
    // mermaid leaves its temporary error element in the body
    document.getElementById(`dado-mermaid-${counter - 1}`)?.remove();
    return false;
  }
}
