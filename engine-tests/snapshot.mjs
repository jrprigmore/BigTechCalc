/*
 * Renders index.html + app.js in jsdom and writes a self-contained
 * static snapshot with the CSS inlined, so the design can be inspected
 * in a browser without running a server.
 *
 * The snapshot is a dead page — no interactivity. It exists to check
 * layout and typography, not behaviour.
 *
 * Run: node engine-tests/snapshot.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..', 'site');

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});

let html = readFileSync(join(siteDir, 'index.html'), 'utf8')
  .replace(/<script[^>]*pagead2[^>]*><\/script>/g, '')
  .replace(/<script type="module"[^>]*><\/script>/g, '');

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: 'https://bigtechcalc.com/',
  pretendToBeVisual: true, virtualConsole: vc,
});
const { window } = dom;
for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'Event',
                 'CustomEvent', 'getComputedStyle', 'location', 'btoa', 'atob',
                 'TextEncoder', 'TextDecoder', 'requestAnimationFrame']) {
  if (window[k] === undefined) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); }
}
Object.defineProperty(globalThis, 'navigator',
  { value: window.navigator, configurable: true, writable: true });
globalThis.fetch = async () => { throw new Error('offline'); };

await import(pathToFileURL(join(siteDir, 'js', 'app.js')).href);
await new Promise((r) => setTimeout(r, 500));

const css = readFileSync(join(siteDir, 'css', 'style.css'), 'utf8');
const doc = window.document;

// Inline the stylesheet, drop the local <link>, neutralise ad slots.
for (const l of [...doc.querySelectorAll('link[rel="stylesheet"]')]) {
  if (l.href.includes('/css/style.css')) l.remove();
}
const style = doc.createElement('style');
style.textContent = css;
doc.head.appendChild(style);
for (const a of [...doc.querySelectorAll('.ad')]) {
  a.innerHTML = '<span style="font:11px IBM Plex Mono,monospace;letter-spacing:.1em;color:#6B7A90">AD SLOT — ' + a.id.replace('ad-', '').toUpperCase() + '</span>';
}
for (const s of [...doc.querySelectorAll('script')]) s.remove();

const out = join(here, 'out', 'snapshot.html');
writeFileSync(out, '<!DOCTYPE html>\n' + doc.documentElement.outerHTML);
console.log('Snapshot written: ' + out);
console.log('Stat cards: ' + doc.querySelectorAll('#statGrid .stat').length);
console.log('Chart nodes: ' + doc.querySelectorAll('.chart-box svg').length);
console.log('Detail rows: ' + doc.querySelectorAll('#detailTable tbody tr').length);
console.log('Ledger rows: ' + doc.querySelectorAll('#ledgerTable tbody tr').length);
