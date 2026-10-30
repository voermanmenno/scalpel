// Headless browser globals (jsdom) so Milkdown/ProseMirror run under Node.
// Import this before loading the editor modules.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const g = globalThis as any;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if ((key in g && !/^(navigator|window)$|Event(Target)?$/.test(key)) || /Storage$/.test(key)) continue;
  const value = (dom.window as any)[key];
  Object.defineProperty(g, key, { value: typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value, configurable: true, writable: true });
}
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent'])
  g[key] = (dom.window as any)[key].bind(dom.window);
