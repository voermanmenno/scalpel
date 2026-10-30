// Builds the extension host bundle (Node, CommonJS) and the webview bundle (browser, IIFE + CSS).
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

// Mermaid (5 MB) is not bundled: the webview loads this copy only when a page has a diagram.
mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/mermaid.min.js');

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info' };

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022', minify: !watch },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map(options => esbuild.build(options)));
}
