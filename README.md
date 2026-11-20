# Malloy Notebook Viewer

Open, run and share Malloy notebooks (`.malloynb`) in the browser, like Colab for Malloy.
The Malloy compiler, DuckDB-WASM and the Malloy renderer all run in the browser, so the
site is static: no server and nothing to install.

**Live site:** https://mrtimo.github.io/malloynb/

**Try it:** [an MLB analysis notebook](https://mrtimo.github.io/malloynb/github/mrtimo/malloynb-examples/blob/main/mlb_games.malloynb)

## Share a notebook

Put the `.malloynb` file in a public GitHub repo, then replace `github.com` in its address
with `mrtimo.github.io/malloynb/github`:

```
https://github.com/user/repo/blob/main/analysis.malloynb
https://mrtimo.github.io/malloynb/github/user/repo/blob/main/analysis.malloynb
```

| Link | Opens |
| --- | --- |
| `<site>/github/<owner>/<repo>/blob/<ref>/<path>.malloynb` | A notebook on GitHub |
| `<site>/?url=<any public URL>` | Any public `.malloynb` (GitHub blob links are converted to raw automatically) |
| `...#code=<compressed>` | A notebook with edits, packed into the link by **Share** |

You can also drag and drop a `.malloynb` file onto the page, with any `.malloy` imports and
data files it uses.

## What works

- Notebooks that use the `duckdb` connection with public Parquet or CSV files.
- The data host must allow cross-site requests (CORS). GitHub raw files, Hugging Face and
  shell.duckdb.org do. Many S3 buckets and government portals don't.
- `import "x.malloy"` resolves relative to the notebook's URL.
- `duckdb.table('data/x.parquet')` tries the notebook's folder first, then the repo root,
  because VS Code resolves DuckDB paths against the workspace folder.
- Cells can be edited and re-run (Shift+Enter). Edits are kept by sharing a link or
  downloading the file. Nothing is saved back to GitHub.

Not supported: other connections (BigQuery, Postgres, MotherDuck), SQL cells, local file
paths such as `C:\Users\...`, and Git LFS files.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

## Fork and deploy your own copy

1. Fork this repo.
2. In the fork, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`, or run the **Deploy to GitHub Pages** workflow by hand.

The workflow builds the site for `https://<you>.github.io/<repo-name>/`, so it works under
any repo name. `dist/404.html` is a copy of `index.html`, so `/github/...` links load the app
on GitHub Pages. For Vercel, `vercel.json` does the same with a rewrite; build without
`BASE_PATH`.

## How it works

| File | What it does |
| --- | --- |
| `src/engine.ts` | Malloy runtime, DuckDB-WASM connection, relative-path resolution, error hints |
| `src/notebook.ts` | `.malloynb` parse and serialize |
| `src/main.ts` | UI: cells, editing, running, sharing, drag and drop, URL routing |
| `src/highlight.ts` | Malloy syntax highlighting for the code cells |
| `public/examples/flights.malloynb` | Test notebook (public Parquet on GitHub) |

Each Malloy cell is compiled with `extendModel` on top of the cells before it, the way VS
Code does it. If a cell defines a query, the last one is run and drawn with
`@malloydata/render`. Versions are pinned in `package.json`, and the page footer shows them.

Ideas for improvements: a schema browser, saving to GitHub (needs OAuth), a "check my
notebook" button that tests each data URL for CORS, and multithreaded DuckDB through a
COOP/COEP service worker.

## License

MIT
