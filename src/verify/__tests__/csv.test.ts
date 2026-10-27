import { describe, expect, it } from "vitest";
import { toCsv } from "../../open-record/render";
import { parseCsv } from "../csv";

describe("parseCsv", () => {
  it("reads back what the renderer writes, quotes, commas and line breaks included", () => {
    const rows = [
      { date: "2026-10-25", reason: 'a "quoted" word, a comma', note: "two\r\nlines" },
      { date: "2026-10-26", reason: "", note: "plain" },
    ];
    expect(parseCsv(toCsv(["date", "reason", "note"], rows))).toEqual(rows);
  });

  it("refuses a row whose cell count is not the header's", () => {
    expect(() => parseCsv("a,b\r\n1,2,3\r\n")).toThrow(/3 cells/);
  });

  it("refuses a file that ends inside a quoted cell", () => {
    expect(() => parseCsv('a\r\n"open')).toThrow(/quoted/);
  });
});
