// The Malloy + DuckDB-WASM engine. Everything runs in the browser.

import {
  API,
  MalloyError,
  Runtime,
  type ModelMaterializer,
  type QueryMaterializer,
  type URLReader,
} from '@malloydata/malloy';
import {DuckDBWASMConnection} from '@malloydata/db-duckdb/wasm';
import * as duckdb from '@duckdb/duckdb-wasm';
import type * as Malloy from '@malloydata/malloy-interfaces';

/** Where the notebook came from: decides how relative paths resolve. */
export interface NotebookOrigin {
  /** URL of the .malloynb (http(s) for remote, file:///dropped/... for drag-and-drop). */
  url: URL;
  /** Files the user dropped alongside the notebook, keyed by file name. */
  droppedFiles: Map<string, File>;
}

/** DuckDB's connection default is 10 rows, which cuts charts short. */
export const ROW_LIMIT = 5000;

const FILE_TABLE = /\.(parquet|csv|tsv|json|jsonl|ndjson)(\?.*)?$/i;

/**
 * DuckDB-WASM connection that resolves relative table paths
 * (e.g. duckdb.table('data/flights.parquet')) against the notebook's URL,
 * or against files the user dropped in.
 */
class NotebookDuckDB extends DuckDBWASMConnection {
  origin: NotebookOrigin | null = null;
  private registered = new Set<string>();

  getBundles(): duckdb.DuckDBBundles {
    // Served from jsDelivr, version pinned by package.json.
    return duckdb.getJsDelivrBundles();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchSchemaForTables(missing: Record<string, string>, options: any) {
    await this.registerRelative(Object.values(missing));
    return super.fetchSchemaForTables(missing, options);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchSchemaForSQLStruct(sqlRef: any, options: any) {
    const paths: string[] = [];
    const sql: string = sqlRef?.selectStr ?? '';
    for (const m of sql.matchAll(/(?:FROM|JOIN|\(\s*)\s*'([^']+)'/gi)) paths.push(m[1]);
    await this.registerRelative(paths);
    return super.fetchSchemaForSQLStruct(sqlRef, options);
  }

  private async registerRelative(tables: string[]) {
    await this.setup();
    // Malloy passes canonical, SQL-quoted paths: 'data/flights.parquet'
    for (const raw of tables) {
      const tablePath = raw.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
      if (/^(https?|s3|gs|hf):\/\//i.test(tablePath)) continue;
      if (this.registered.has(tablePath) || !this.origin) continue;
      if (!FILE_TABLE.test(tablePath)) continue;
      if (/^([a-zA-Z]:\\|\/Users\/|\/home\/|~)/.test(tablePath)) {
        throw new Error(
          `"${tablePath}" is a path on someone's own computer, so a browser can't read it. ` +
            'Use a public https:// URL for the data instead.'
        );
      }
      const dropped =
        this.origin.droppedFiles.get(tablePath) ??
        this.origin.droppedFiles.get(tablePath.split('/').pop()!);
      if (dropped) {
        const buf = new Uint8Array(await dropped.arrayBuffer());
        await this.database?.registerFileBuffer(tablePath, buf);
        // Mark as handled so the base class doesn't try to fetch it again.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).remoteFileStatus[tablePath] = Promise.resolve(Number.MIN_SAFE_INTEGER);
        this.registered.add(tablePath);
        continue;
      }
      if (/^https?:$/.test(this.origin.url.protocol)) {
        const resolved = await resolveRelativeData(tablePath, this.origin.url);
        await this.registerRemoteTable(tablePath, resolved);
        this.registered.add(tablePath);
      }
    }
  }

  resetRegistrations() {
    this.registered.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).remoteFileStatus = {};
  }
}

/**
 * Find the URL for a relative data path. VS Code resolves DuckDB paths against the
 * workspace folder, which is usually the repo root, not the notebook's folder. So for
 * GitHub notebooks we try the notebook's folder first, then the repo root.
 */
async function resolveRelativeData(path: string, notebookUrl: URL): Promise<string> {
  const candidates = [new URL(path, notebookUrl).toString()];
  const gh = notebookUrl
    .toString()
    .match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//);
  if (gh) candidates.push(new URL(path.replace(/^\.?\//, ''), gh[0]).toString());
  for (const url of candidates) {
    try {
      const res = await fetch(url, {method: 'HEAD'});
      if (res.ok) return url;
    } catch {
      /* try the next one */
    }
  }
  return candidates[0]; // let DuckDB report the error for the most likely location
}

export type CellRun =
  | {kind: 'model-only'; problems: Problem[]}
  | {
      kind: 'result';
      result: Malloy.Result;
      sql: string;
      rows: number;
      ms: number;
      problems: Problem[];
    };

export interface Problem {
  message: string;
  line?: number; // 1-based, relative to the cell
  severity: string;
}

export class CellError extends Error {
  constructor(
    message: string,
    public problems: Problem[],
    public hint?: string
  ) {
    super(message);
  }
}

export class Engine {
  readonly connection: NotebookDuckDB;
  readonly runtime: Runtime;
  private origin: NotebookOrigin = {
    url: new URL('file:///notebook.malloynb'),
    droppedFiles: new Map(),
  };

  constructor() {
    this.connection = new NotebookDuckDB('duckdb');
    const urlReader: URLReader = {
      readURL: async (url: URL) => this.readURL(url),
    };
    this.runtime = new Runtime({urlReader, connection: this.connection});
  }

  async ready(): Promise<void> {
    await this.connection.setup();
  }

  setOrigin(origin: NotebookOrigin) {
    this.origin = origin;
    this.connection.origin = origin;
    this.connection.resetRegistrations();
  }

  /** Reads imported .malloy files. */
  private async readURL(url: URL): Promise<string> {
    if (url.protocol === 'file:') {
      const name = url.pathname.split('/').pop() ?? '';
      const file =
        this.origin.droppedFiles.get(url.pathname.replace(/^\/dropped\//, '')) ??
        this.origin.droppedFiles.get(name);
      if (file) return await file.text();
      throw new Error(
        `This notebook imports "${name}", but that file wasn't provided. ` +
          'Drop the .malloy file in together with the notebook, or open the notebook from its GitHub URL.'
      );
    }
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
    return await res.text();
  }

  /**
   * Compile a malloy cell on top of the model built by the earlier cells.
   * Returns the new model materializer and whether this cell added a query.
   */
  async compileCell(
    prev: ModelMaterializer | null,
    text: string
  ): Promise<{mm: ModelMaterializer; queryCount: number}> {
    const opts = {importBaseURL: this.origin.url};
    const mm = prev ? prev.extendModel(text, opts) : this.runtime.loadModel(text, opts);
    try {
      const model = await mm.getModel();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryCount: number = (model as any).modelDef?.queryList?.length ?? 0;
      return {mm, queryCount};
    } catch (e) {
      throw toCellError(e);
    }
  }

  async runFinalQuery(mm: ModelMaterializer): Promise<CellRun> {
    const qm: QueryMaterializer = mm.loadFinalQuery();
    let sql = '';
    try {
      sql = await qm.getSQL();
      const t0 = performance.now();
      const result = await qm.run({rowLimit: ROW_LIMIT});
      const ms = performance.now() - t0;
      return {
        kind: 'result',
        result: API.util.wrapResult(result),
        sql,
        rows: result.data.rowCount,
        ms,
        problems: [],
      };
    } catch (e) {
      const err = toCellError(e);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err as any).sql = sql;
      throw err;
    }
  }
}

function toCellError(e: unknown): CellError {
  if (e instanceof CellError) return e;
  if (e instanceof MalloyError) {
    const problems: Problem[] = e.problems.map(p => ({
      message: p.message,
      severity: p.severity,
      line: p.at ? p.at.range.start.line + 1 : undefined,
    }));
    return new CellError(e.message, problems, dataHint(problems.map(p => p.message).join('\n')));
  }
  const message = e instanceof Error ? e.message : String(e);
  return new CellError(message, [], dataHint(message));
}

/** Turn opaque DuckDB/browser errors about remote data into something a student can act on. */
export function dataHint(message: string): string | undefined {
  if (/magic bytes|not a parquet file|No magic/i.test(message)) {
    return (
      "The file downloaded, but it isn't Parquet data. If the file is stored with Git LFS, " +
      'GitHub serves a small pointer file instead. Use the "media.githubusercontent.com" URL or host it elsewhere.'
    );
  }
  if (
    /HTTP|NetworkError|Failed to fetch|CORS|IO Error|No files found|Failed to open|Unable to connect|404|403/i.test(message)
  ) {
    return (
      "The browser couldn't download the data. In the browser, the data host must allow " +
      'cross-site requests (CORS) and the URL must be public https. Hosts that work: ' +
      'raw.githubusercontent.com, huggingface.co, shell.duckdb.org, and any S3/R2 bucket with CORS enabled.'
    );
  }
  if (/Out of Memory|memory access out of bounds/i.test(message)) {
    return 'The browser ran out of memory. Try filtering the data or selecting fewer columns.';
  }
  return undefined;
}

export const VERSIONS = {
  malloy: __MALLOY_VERSION__,
  duckdbWasm: __DUCKDB_WASM_VERSION__,
};

declare const __MALLOY_VERSION__: string;
declare const __DUCKDB_WASM_VERSION__: string;
