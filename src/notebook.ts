// Parse / serialize the .malloynb format.
//
// A .malloynb file is plain text. Each cell starts with a delimiter line:
//   >>>markdown
//   >>>malloy
// (VS Code also accepts >>>sql; we treat it as an unsupported cell.)

export type CellType = 'markdown' | 'malloy' | 'sql';

export interface Cell {
  id: string;
  type: CellType;
  text: string;
}

let nextId = 1;
export function newCellId(): string {
  return `c${nextId++}`;
}

const DELIM = /^>>>(markdown|malloy|sql)\b(.*)$/;

export function parseMalloyNB(source: string): Cell[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const cells: Cell[] = [];
  let current: Cell | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current) {
      current.text = trimBlankEdges(buf.join('\n'));
      cells.push(current);
    } else if (buf.join('').trim() !== '') {
      // Text before the first delimiter: treat it as Malloy (VS Code does the same
      // for a file with no delimiters at all).
      cells.push({id: newCellId(), type: 'malloy', text: trimBlankEdges(buf.join('\n'))});
    }
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(DELIM);
    if (m) {
      flush();
      current = {id: newCellId(), type: m[1] as CellType, text: ''};
    } else {
      buf.push(line);
    }
  }
  flush();
  return cells;
}

export function serializeMalloyNB(cells: Cell[]): string {
  return cells.map(c => `>>>${c.type}\n${c.text}`).join('\n') + '\n';
}

function trimBlankEdges(s: string): string {
  return s.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
}
