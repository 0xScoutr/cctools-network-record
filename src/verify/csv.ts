/**
 * RFC 4180 reading for the published CSVs: a header row, CRLF line ends,
 * quoted cells with "" for a quote, and quoted cells that hold commas or line
 * breaks. Every cell comes back as text; an empty cell is "".
 */

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  return body.map((cells, i) => {
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${i + 2} has ${cells.length} cells, the header has ${header.length}`);
    }
    return Object.fromEntries(header.map((name, j) => [name, cells[j]]));
  });
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 2;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (quoted) throw new Error("CSV ends inside a quoted cell");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
