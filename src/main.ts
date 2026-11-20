import './style.css';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {MalloyRenderer} from '@malloydata/render';
import type {ModelMaterializer} from '@malloydata/malloy';
import {CellError, Engine, ROW_LIMIT, VERSIONS, type CellRun, type NotebookOrigin} from './engine';
import {newCellId, parseMalloyNB, serializeMalloyNB, type Cell, type CellType} from './notebook';
import {highlightMalloy} from './highlight';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function setStatus(msg: string, kind: 'busy' | 'ok' | 'error' | '' = '') {
  const s = $('nb-status');
  s.textContent = msg;
  s.dataset.kind = kind;
}

// ---------------------------------------------------------------------------
// Engine (starts loading DuckDB right away, in parallel with the notebook fetch)
// ---------------------------------------------------------------------------

const engine = new Engine();
const engineReady = engine.ready();
const renderer = new MalloyRenderer();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (import.meta.env.DEV) (window as any).__engine = engine;

// ---------------------------------------------------------------------------
// Notebook state
// ---------------------------------------------------------------------------

interface CellUI {
  root: HTMLElement;
  output: HTMLElement;
  runBtn?: HTMLButtonElement;
  status?: HTMLElement;
}

interface Compiled {
  key: string;
  mm: ModelMaterializer;
  queryCount: number;
}

const state = {
  cells: [] as Cell[],
  ui: new Map<string, CellUI>(),
  compiled: new Map<string, Compiled>(),
  failed: new Map<string, string>(), // cellId -> compile key that failed
  origin: null as NotebookOrigin | null,
  sourceUrl: null as string | null, // remote URL of the notebook, if any
  sourceName: 'notebook.malloynb',
  originalText: '',
  running: false,
};

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/** Where the app is served from: "/" locally, "/<repo>/" on GitHub Pages. */
const BASE = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : import.meta.env.BASE_URL + '/';
/** Absolute site URL without a trailing slash, e.g. https://user.github.io/malloynb */
const SITE = (location.origin + BASE).replace(/\/$/, '');

/** github.com/.../blob/... → raw.githubusercontent.com/... (raw files allow CORS). */
function toRawUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    // "user/repo/blob/main/x.malloynb" shorthand
    return toRawUrl('https://github.com/' + input.trim().replace(/^\/+/, ''));
  }
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    // owner/repo/(blob|raw)/ref/path...
    if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
      const [owner, repo, , ...rest] = parts;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`;
    }
  }
  if (u.hostname === 'gist.github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`;
  }
  return u.toString();
}

/** raw.githubusercontent.com/... → github.com/.../blob/... (for "View on GitHub"). */
function toGithubPage(raw: string): string | null {
  const m = raw.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}`;
}

/** The nicest shareable viewer link for a remote notebook URL. */
function viewerLink(raw: string): string {
  const gh = toGithubPage(raw);
  if (gh) return `${SITE}/github/${gh.replace('https://github.com/', '')}`;
  return `${SITE}/?url=${encodeURIComponent(raw)}`;
}

/** Work out which notebook the current page URL points at. */
function notebookFromLocation(): string | null {
  let path = decodeURIComponent(location.pathname);
  if (path.startsWith(BASE)) path = '/' + path.slice(BASE.length);
  if (path.startsWith('/github/')) {
    return toRawUrl('https://github.com/' + path.slice('/github/'.length));
  }
  const q = new URLSearchParams(location.search);
  const url = q.get('url') ?? q.get('nb');
  if (url) return toRawUrl(url);
  return null;
}

// Edited notebooks are shared by compressing them into the URL fragment
// (#code=...), which never leaves the browser in requests.
async function compress(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decompress(b64: string): Promise<string> {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const buf = Uint8Array.from(bin, c => c.charCodeAt(0));
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function openFromUrl(rawUrl: string, embedded?: string) {
  showNotebookShell();
  const url = new URL(rawUrl);
  state.sourceUrl = url.toString();
  state.sourceName = decodeURIComponent(url.pathname.split('/').pop() || 'notebook.malloynb');
  renderSourceLine();
  let text: string;
  if (embedded !== undefined) {
    text = embedded;
  } else {
    setStatus('Downloading notebook…', 'busy');
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      text = await res.text();
    } catch (e) {
      setStatus('', '');
      $('cells').replaceChildren(
        errorBox(
          `Couldn't download the notebook: ${(e as Error).message}`,
          'Check that the file is public. For GitHub, the repository must be public. ' +
            'Some sites block cross-site downloads; GitHub, GitLab raw links and gists work.'
        )
      );
      return;
    }
    // The original from GitHub is the baseline for "edited?" detection.
    state.originalText = text;
  }
  if (embedded !== undefined) {
    // Fetch the original in the background so we know whether the embedded copy differs.
    fetch(url.toString())
      .then(r => (r.ok ? r.text() : ''))
      .then(t => (state.originalText = t))
      .catch(() => {});
  }
  await loadNotebook(text, {url, droppedFiles: new Map()});
}

async function openFromFiles(files: File[]) {
  const nbFile =
    files.find(f => f.name.endsWith('.malloynb')) ?? files.find(f => f.name.endsWith('.malloy'));
  if (!nbFile) {
    toast('Drop a .malloynb file (plus any .malloy or data files it uses).');
    return;
  }
  const dropped = new Map<string, File>();
  for (const f of files) {
    dropped.set(f.name, f);
    // Folder drops carry a relative path, e.g. "project/data/x.parquet"
    const rel = (f as File & {webkitRelativePath?: string}).webkitRelativePath;
    if (rel) dropped.set(rel.split('/').slice(1).join('/'), f);
  }
  let text = await nbFile.text();
  if (nbFile.name.endsWith('.malloy')) text = `>>>malloy\n${text}`;
  state.sourceUrl = null;
  state.sourceName = nbFile.name;
  state.originalText = '';
  history.replaceState(null, '', BASE);
  showNotebookShell();
  renderSourceLine(files.length > 1 ? `${files.length - 1} supporting file(s)` : undefined);
  await loadNotebook(text, {url: new URL(`file:///dropped/${nbFile.name}`), droppedFiles: dropped});
}

async function loadNotebook(text: string, origin: NotebookOrigin) {
  state.cells = parseMalloyNB(text);
  state.origin = origin;
  state.compiled.clear();
  state.failed.clear();
  engine.setOrigin(origin);
  renderCells();
  document.title = `${state.sourceName.replace(/\.malloynb$/, '')} · Malloy Notebook`;
  setStatus('Starting DuckDB…', 'busy');
  try {
    await engineReady;
  } catch (e) {
    setStatus(`DuckDB failed to start: ${(e as Error).message}`, 'error');
    return;
  }
  await runAll();
}

function showNotebookShell() {
  $('welcome').hidden = true;
  $('notebook').hidden = false;
  $('nb-actions').hidden = false;
}

function renderSourceLine(extra?: string) {
  const el = $('nb-source');
  el.replaceChildren();
  el.append(h('span', {class: 'nb-name'}, state.sourceName));
  if (state.sourceUrl) {
    const gh = toGithubPage(state.sourceUrl);
    el.append(
      h('a', {href: gh ?? state.sourceUrl, target: '_blank', rel: 'noopener'}, gh ? 'View on GitHub' : 'Source')
    );
  } else {
    el.append(h('span', {class: 'dim'}, 'Opened from your computer'));
  }
  if (extra) el.append(h('span', {class: 'dim'}, extra));
}

// ---------------------------------------------------------------------------
// Rendering cells
// ---------------------------------------------------------------------------

function renderCells() {
  const container = $('cells');
  container.replaceChildren();
  state.ui.clear();
  state.cells.forEach(cell => container.append(buildCell(cell)));
  if (state.cells.length === 0) container.append(addBar(-1));
}

function buildCell(cell: Cell): HTMLElement {
  const root = h('div', {class: `cell cell-${cell.type}`, 'data-id': cell.id});
  const output = h('div', {class: 'cell-output'});
  const ui: CellUI = {root, output};
  state.ui.set(cell.id, ui);

  if (cell.type === 'markdown') {
    const view = h('div', {class: 'md'});
    const editor = h('textarea', {class: 'md-editor', spellcheck: 'true'}) as HTMLTextAreaElement;
    editor.hidden = true;
    const draw = () => {
      view.innerHTML = renderMarkdown(cell.text);
      view.classList.toggle('empty', cell.text.trim() === '');
    };
    const finish = () => {
      cell.text = editor.value;
      editor.hidden = true;
      view.hidden = false;
      draw();
    };
    view.title = 'Double-click to edit';
    view.addEventListener('dblclick', () => {
      editor.value = cell.text;
      view.hidden = true;
      editor.hidden = false;
      autosize(editor);
      editor.focus();
    });
    editor.addEventListener('input', () => autosize(editor));
    editor.addEventListener('blur', finish);
    editor.addEventListener('keydown', e => {
      if ((e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) || e.key === 'Escape') {
        e.preventDefault();
        editor.blur();
      }
    });
    draw();
    root.append(cellTools(cell), view, editor);
  } else {
    const runBtn = h('button', {class: 'run-btn', title: 'Run cell (Shift+Enter)', 'aria-label': 'Run cell'}) as HTMLButtonElement;
    runBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
    runBtn.addEventListener('click', () => runSingle(cell.id));
    const status = h('div', {class: 'cell-status'});
    ui.runBtn = runBtn;
    ui.status = status;

    const editor = codeEditor(cell, () => runSingle(cell.id, true));
    const gutter = h('div', {class: 'gutter'}, runBtn, status);
    root.append(cellTools(cell), h('div', {class: 'code-row'}, gutter, editor), output);
    if (cell.type === 'sql') {
      output.append(
        errorBox(
          'SQL cells are not supported in the browser viewer.',
          'Rewrite this as a Malloy cell using duckdb.sql("...").'
        )
      );
    }
  }
  return root;
}

function cellTools(cell: Cell): HTMLElement {
  const label = cell.type === 'markdown' ? 'Markdown' : cell.type === 'sql' ? 'SQL' : 'Malloy';
  const tools = h('div', {class: 'cell-tools'});
  const add = (type: CellType, text: string) => {
    const b = h('button', {class: 'tool', title: `Add a ${type} cell below`}, text);
    b.addEventListener('click', () => insertCell(cell.id, type));
    return b;
  };
  const del = h('button', {class: 'tool', title: 'Delete cell'}, 'Delete');
  del.addEventListener('click', () => deleteCell(cell.id));
  tools.append(h('span', {class: 'cell-type'}, label), add('malloy', '+ Code'), add('markdown', '+ Text'), del);
  return tools;
}

function addBar(_after: number): HTMLElement {
  const bar = h('div', {class: 'add-bar'});
  for (const [type, text] of [
    ['malloy', '+ Code'],
    ['markdown', '+ Text'],
  ] as const) {
    const b = h('button', {class: 'btn'}, text);
    b.addEventListener('click', () => insertCell(null, type));
    bar.append(b);
  }
  return bar;
}

function insertCell(afterId: string | null, type: CellType) {
  const cell: Cell = {id: newCellId(), type, text: ''};
  const idx = afterId ? state.cells.findIndex(c => c.id === afterId) + 1 : state.cells.length;
  state.cells.splice(idx, 0, cell);
  const el = buildCell(cell);
  const container = $('cells');
  if (state.cells.length === 1) container.replaceChildren(el);
  else if (afterId) state.ui.get(afterId)!.root.after(el);
  else container.append(el);
  if (type === 'malloy') el.querySelector('textarea')?.focus();
  else el.querySelector<HTMLElement>('.md')?.dispatchEvent(new MouseEvent('dblclick'));
}

function deleteCell(id: string) {
  const idx = state.cells.findIndex(c => c.id === id);
  if (idx < 0) return;
  state.cells.splice(idx, 1);
  state.ui.get(id)?.root.remove();
  state.ui.delete(id);
  state.compiled.delete(id);
  if (state.cells.length === 0) $('cells').append(addBar(-1));
}

function codeEditor(cell: Cell, onRun: () => void): HTMLElement {
  const wrap = h('div', {class: 'code'});
  const pre = h('pre', {class: 'code-hl', 'aria-hidden': 'true'});
  const ta = h('textarea', {
    class: 'code-input',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Malloy code',
  }) as HTMLTextAreaElement;
  ta.value = cell.text;
  const draw = () => {
    pre.innerHTML = highlightMalloy(ta.value);
  };
  ta.addEventListener('input', () => {
    cell.text = ta.value;
    draw();
    state.ui.get(cell.id)?.root.classList.add('dirty');
  });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onRun();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  });
  draw();
  wrap.append(pre, ta);
  return wrap;
}

function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

function renderMarkdown(src: string): string {
  const html = marked.parse(src, {async: false, gfm: true}) as string;
  const clean = DOMPurify.sanitize(html, {ADD_ATTR: ['target']});
  // Rewrite links: relative links to other notebooks open in this viewer.
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  for (const a of tpl.content.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')!;
    if (href.startsWith('#')) continue;
    let abs: URL | null = null;
    try {
      abs = new URL(href, state.origin?.url ?? location.href);
    } catch {
      continue;
    }
    if (/\.malloynb$/i.test(abs.pathname) && /^https?:$/.test(abs.protocol)) {
      a.setAttribute('href', viewerLink(toRawUrl(abs.toString())));
    } else if (/^https?:$/.test(abs.protocol)) {
      a.setAttribute('href', abs.toString());
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
  }
  for (const img of tpl.content.querySelectorAll('img[src]')) {
    try {
      img.setAttribute('src', new URL(img.getAttribute('src')!, state.origin?.url ?? location.href).toString());
    } catch {
      /* ignore */
    }
  }
  return tpl.innerHTML;
}

function errorBox(message: string, hint?: string, lines?: {line?: number; message: string}[]): HTMLElement {
  const box = h('div', {class: 'error-box'});
  if (lines && lines.length) {
    const list = h('ul');
    for (const p of lines) {
      list.append(h('li', {}, p.line ? h('span', {class: 'line'}, `Line ${p.line}`) : '', p.message));
    }
    box.append(list);
  } else {
    box.append(h('div', {class: 'msg'}, message));
  }
  if (hint) box.append(h('div', {class: 'hint'}, hint));
  return box;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Compile malloy cells 0..targetIndex, reusing earlier compiles when nothing above changed.
 * A cell that fails to compile is skipped, so later independent cells still work.
 */
async function compileThrough(targetIndex: number): Promise<{
  mm: ModelMaterializer | null;
  addsQuery: boolean;
  error?: CellError;
}> {
  let prev: Compiled | null = null;
  let prevKey = '';
  for (let i = 0; i <= targetIndex; i++) {
    const cell = state.cells[i];
    if (cell.type !== 'malloy' || cell.text.trim() === '') {
      if (i === targetIndex) return {mm: prev?.mm ?? null, addsQuery: false};
      continue;
    }
    const key = prevKey + '\u0000' + cell.text;
    let entry = state.compiled.get(cell.id);
    if (!entry || entry.key !== key) {
      if (state.failed.get(cell.id) === key && i !== targetIndex) {
        continue; // known-bad cell above the target; skip it
      }
      try {
        const {mm, queryCount} = await engine.compileCell(prev?.mm ?? null, cell.text);
        entry = {key, mm, queryCount};
        state.compiled.set(cell.id, entry);
        state.failed.delete(cell.id);
      } catch (e) {
        state.failed.set(cell.id, key);
        state.compiled.delete(cell.id);
        if (i === targetIndex) return {mm: null, addsQuery: false, error: e as CellError};
        continue;
      }
    }
    if (i === targetIndex) {
      // queryList holds only the queries written in this cell (it resets per extension).
      return {mm: entry.mm, addsQuery: entry.queryCount > 0};
    }
    prev = entry;
    prevKey = key;
  }
  return {mm: prev?.mm ?? null, addsQuery: false};
}

async function runCell(id: string) {
  const idx = state.cells.findIndex(c => c.id === id);
  const cell = state.cells[idx];
  const ui = state.ui.get(id);
  if (!cell || !ui || cell.type !== 'malloy') return;
  ui.root.classList.remove('dirty', 'ok', 'err');
  ui.root.classList.add('running');
  ui.status!.textContent = '';
  if (cell.text.trim() === '') {
    ui.output.replaceChildren();
    ui.root.classList.remove('running');
    return;
  }
  const t0 = performance.now();
  try {
    const {mm, addsQuery, error} = await compileThrough(idx);
    if (error) throw error;
    if (!mm) throw new CellError('Nothing to run.', []);
    if (!addsQuery) {
      ui.output.replaceChildren(h('div', {class: 'model-note'}, '✓ Compiled. This cell defines sources or queries for later cells.'));
      ui.root.classList.add('ok');
      ui.status!.textContent = `${fmtMs(performance.now() - t0)}`;
      return;
    }
    const run = await engine.runFinalQuery(mm);
    showResult(ui, run);
    ui.root.classList.add('ok');
    ui.status!.textContent = fmtMs(performance.now() - t0);
  } catch (e) {
    const err = e instanceof CellError ? e : new CellError(String(e), []);
    ui.output.replaceChildren(errorBox(err.message, err.hint, err.problems));
    ui.root.classList.add('err');
    ui.status!.textContent = '';
  } finally {
    ui.root.classList.remove('running');
  }
}

function showResult(ui: CellUI, run: CellRun) {
  if (run.kind !== 'result') return;
  const tabs = h('div', {class: 'out-tabs'});
  const resultPane = h('div', {class: 'out-pane result-pane'});
  const sqlPane = h('pre', {class: 'out-pane sql-pane'}, run.sql);
  sqlPane.hidden = true;
  const mk = (label: string, pane: HTMLElement) => {
    const b = h('button', {class: 'out-tab'}, label);
    b.addEventListener('click', () => {
      for (const t of tabs.querySelectorAll('.out-tab')) t.classList.remove('active');
      b.classList.add('active');
      resultPane.hidden = pane !== resultPane;
      sqlPane.hidden = pane !== sqlPane;
    });
    return b;
  };
  const rt = mk('Results', resultPane);
  rt.classList.add('active');
  tabs.append(rt, mk('SQL', sqlPane), h('span', {class: 'out-meta'}, run.rows >= ROW_LIMIT ? `first ${ROW_LIMIT.toLocaleString()} rows` : `${run.rows.toLocaleString()} row${run.rows === 1 ? '' : 's'}`));
  ui.output.replaceChildren(tabs, resultPane, sqlPane);
  try {
    const viz = renderer.createViz({scrollEl: resultPane});
    viz.setResult(run.result);
    viz.render(resultPane);
    // Charts use "fill" sizing and take the container's height, which is 0 for an
    // auto-height div. Tables size themselves. If nothing drew, give charts room.
    requestAnimationFrame(() => {
      const r = resultPane.querySelector<HTMLElement>('.malloy-render');
      if (r && r.getBoundingClientRect().height < 8) {
        resultPane.classList.add('chart');
      }
    });
  } catch (e) {
    resultPane.replaceChildren(errorBox(`The result couldn't be drawn: ${(e as Error).message}`));
  }
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function runSingle(id: string, fromKeyboard = false) {
  if (state.running) {
    toast('Wait for the current run to finish.');
    return;
  }
  state.running = true;
  try {
    await runCell(id);
  } finally {
    state.running = false;
  }
  if (fromKeyboard) focusNextCode(id);
}

function focusNextCode(id: string) {
  const idx = state.cells.findIndex(c => c.id === id);
  const next = state.cells.slice(idx + 1).find(c => c.type === 'malloy');
  if (next) state.ui.get(next.id)?.root.querySelector('textarea')?.focus({preventScroll: false});
}

async function runAll() {
  if (state.running) return;
  state.running = true;
  const malloyCells = state.cells.filter(c => c.type === 'malloy' && c.text.trim() !== '');
  let errors = 0;
  const t0 = performance.now();
  try {
    for (const c of malloyCells) state.ui.get(c.id)?.root.classList.add('queued');
    for (let i = 0; i < malloyCells.length; i++) {
      setStatus(`Running cell ${i + 1} of ${malloyCells.length}…`, 'busy');
      state.ui.get(malloyCells[i].id)?.root.classList.remove('queued');
      await runCell(malloyCells[i].id);
      if (state.ui.get(malloyCells[i].id)?.root.classList.contains('err')) errors++;
    }
  } finally {
    state.running = false;
    for (const c of state.cells) state.ui.get(c.id)?.root.classList.remove('queued');
  }
  const took = fmtMs(performance.now() - t0);
  if (errors) setStatus(`Finished in ${took} · ${errors} cell${errors > 1 ? 's' : ''} with errors`, 'error');
  else setStatus(`Ran ${malloyCells.length} cell${malloyCells.length === 1 ? '' : 's'} in ${took}`, 'ok');
}

// ---------------------------------------------------------------------------
// Toolbar: share / download
// ---------------------------------------------------------------------------

async function share() {
  const text = serializeMalloyNB(state.cells);
  const edited = !state.sourceUrl || normalize(text) !== normalize(state.originalText);
  let link: string;
  if (!edited && state.sourceUrl) {
    link = viewerLink(state.sourceUrl);
  } else {
    const code = await compress(text);
    const base = state.sourceUrl ? viewerLink(state.sourceUrl) : `${SITE}/`;
    link = `${base}#code=${code}`;
  }
  // The address bar always gets the link, so it can be copied by hand if needed.
  history.replaceState(null, '', link.replace(location.origin, ''));
  const what = edited
    ? state.sourceUrl
      ? 'It includes your edits.'
      : 'The notebook is stored inside the link.'
    : '';
  const long = link.length > 8000 ? ' The link is very long; putting the notebook on GitHub gives a shorter one.' : '';
  try {
    await Promise.race([
      navigator.clipboard.writeText(link),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    toast(`Link copied. ${what}${long}`.trim());
  } catch {
    toast(`Copy the link from the address bar. ${what}${long}`.trim());
  }
}

function normalize(s: string) {
  return s.replace(/\r\n?/g, '\n').replace(/\s+$/g, '').replace(/\n{2,}/g, '\n');
}

function download() {
  const blob = new Blob([serializeMalloyNB(state.cells)], {type: 'text/plain'});
  const a = h('a', {href: URL.createObjectURL(blob), download: state.sourceName});
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function setupDragAndDrop() {
  const overlay = $('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = await filesFromDrop(e.dataTransfer!);
    if (files.length) openFromFiles(files);
  });
  $<HTMLInputElement>('file-input').addEventListener('change', e => {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    if (files.length) openFromFiles(files);
  });
}

/** Collect files from a drop, walking into dropped folders. */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map(i => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.some(e => e.isDirectory)) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(file, 'webkitRelativePath', {value: prefix + file.name});
      out.push(file);
    } else if (entry.isDirectory && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

function init() {
  const exampleUrl = `${SITE}/examples/flights.malloynb`;
  $('host-example').textContent = SITE.replace(/^https?:\/\//, '');
  $<HTMLAnchorElement>('brand-link').href = BASE;
  $('query-example').textContent = `${SITE}/?url=https://…/analysis.malloynb`;
  $<HTMLAnchorElement>('example-link').href = `${BASE}?url=${encodeURIComponent(exampleUrl)}`;
  $('footer').innerHTML =
    `Runs entirely in your browser · Malloy ${VERSIONS.malloy} · DuckDB-WASM ${VERSIONS.duckdbWasm}`;

  $('url-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = $<HTMLInputElement>('url-input').value.trim();
    if (!v) return;
    const raw = toRawUrl(v);
    history.pushState(null, '', viewerLink(raw).replace(location.origin, ''));
    openFromUrl(raw);
  });
  $('run-all').addEventListener('click', () => runAll());
  $('share').addEventListener('click', () => share());
  $('download').addEventListener('click', () => download());
  window.addEventListener('popstate', () => location.reload());
  setupDragAndDrop();

  const nb = notebookFromLocation();
  const codeMatch = location.hash.match(/[#&]code=([^&]+)/);
  if (nb) $<HTMLInputElement>('url-input').value = toGithubPage(nb) ?? nb;
  if (codeMatch) {
    decompress(codeMatch[1])
      .then(text => {
        if (nb) return openFromUrl(nb, text);
        state.sourceName = 'shared.malloynb';
        showNotebookShell();
        renderSourceLine();
        $('nb-source').querySelector('.dim')!.textContent = 'Shared inside the link';
        return loadNotebook(text, {url: new URL('file:///shared.malloynb'), droppedFiles: new Map()});
      })
      .catch(() => toast("This link's embedded notebook is damaged."));
  } else if (nb) {
    openFromUrl(nb);
  }
}

init();
