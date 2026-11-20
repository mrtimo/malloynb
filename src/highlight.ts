// A small Malloy syntax highlighter for the editable code cells.

const KEYWORDS = new Set([
  'is', 'extend', 'and', 'or', 'not', 'true', 'false', 'null', 'pick', 'when', 'else',
  'by', 'desc', 'asc', 'on', 'with', 'to', 'for', 'now', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'quarter', 'quarters', 'year', 'years', 'hour', 'hours', 'minute',
  'minutes', 'second', 'seconds', 'cast', 'all', 'exclude', 'refine', 'include', 'is_null',
  'number', 'string', 'date', 'timestamp', 'boolean', 'last', 'this',
]);

const TOKEN = new RegExp(
  [
    String.raw`(?<comment>(?://|--)[^\n]*)`,
    String.raw`(?<tag>#[^\n]*)`,
    String.raw`(?<string>'(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?|"""[\s\S]*?(?:"""|$))`,
    String.raw`(?<ident>\x60[^\x60\n]*\x60?)`,
    String.raw`(?<prop>\b[a-z_]+:(?!:))`,
    String.raw`(?<time>@[0-9][0-9\-: T.]*)`,
    String.raw`(?<number>\b\d+(?:\.\d+)?\b)`,
    String.raw`(?<func>\b[A-Za-z_][A-Za-z0-9_]*(?=!?\s*\())`,
    String.raw`(?<word>\b[A-Za-z_][A-Za-z0-9_]*\b)`,
    String.raw`(?<op>->|=>|[{}()\[\],.?=<>!+\-*/%~])`,
  ].join('|'),
  'g'
);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightMalloy(code: string): string {
  let out = '';
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const idx = m.index!;
    out += esc(code.slice(last, idx));
    last = idx + m[0].length;
    const g = m.groups!;
    const text = esc(m[0]);
    let cls = '';
    if (g.comment) cls = 'tk-comment';
    else if (g.tag) cls = 'tk-tag';
    else if (g.string) cls = 'tk-string';
    else if (g.ident) cls = 'tk-ident';
    else if (g.prop) cls = 'tk-prop';
    else if (g.time) cls = 'tk-number';
    else if (g.number) cls = 'tk-number';
    else if (g.func) cls = 'tk-func';
    else if (g.word) cls = KEYWORDS.has(g.word.toLowerCase()) ? 'tk-kw' : '';
    else if (g.op) cls = 'tk-op';
    out += cls ? `<span class="${cls}">${text}</span>` : text;
  }
  out += esc(code.slice(last));
  // A trailing newline needs a character after it so the <pre> grows with the <textarea>.
  return out + '\n ';
}
