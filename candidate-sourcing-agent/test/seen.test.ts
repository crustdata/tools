import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csvCell, parseCsv, writeCsv } from "../src/csv.js";
import { addToSeen, excludeList, isSeenFile, loadSeen, normalizeProfileUrl } from "../src/seen.js";

test("one form for every way a profile URL is written", () => {
  const want = "https://www.example.com/in/example-jane-doe";
  for (const u of ["https://www.example.com/in/example-jane-doe", "http://example.com/in/Example-Jane-Doe/", "HTTPS://UK.EXAMPLE.COM/in/example-jane-doe?trk=x",
    "www.example.com/in/example-jane-doe#about", " https://www.example.com/in/example-jane-doe/details/skills ", "<https://m.example.com/in/example-jane-doe>"]) {
    assert.equal(normalizeProfileUrl(u), want, u);
  }
  assert.equal(normalizeProfileUrl("https://www.example.com/in/%E7%8E%8B%E5%B0%8F%E6%98%8E-example"), normalizeProfileUrl("https://www.example.com/in/王小明-example"));
  assert.equal(normalizeProfileUrl("https://www.example.com/company/example-labs"), "");
  assert.equal(normalizeProfileUrl("not a url"), "");
});

test("an ATS export is read to skip people, and never written to", () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-"));
  const ats = join(dir, "ats.csv");
  const text = "\uFEFFCandidate;Email;Profile;Stage;Notes\nJane Doe;jane@x.example;https://www.example.com/in/example-jane-doe/;Screen;Do not contact until Q1\nNo URL;;;Hired;\nJane again;;HTTP://example.com/in/EXAMPLE-JANE-DOE;x;\n";
  writeFileSync(ats, text);
  const seen = loadSeen(ats);
  assert.equal(seen.byUrl.size, 1);
  assert.equal(seen.rowsWithoutUrl, 1);
  assert.deepEqual(excludeList(seen), ["https://www.example.com/in/example-jane-doe"]);
  assert.equal(isSeenFile(ats), false);
  assert.throws(() => addToSeen(ats, [{ url: "https://www.example.com/in/example-sam", name: "Sam", firstSeen: "2026-10-21", id: 5 }]), /--skip-from/);
  assert.equal(readFileSync(ats, "utf8"), text, "the export is unchanged");
});

test("the tool's own seen list keeps ids, merges with what is on disk, and is owner-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-"));
  const file = join(dir, "seen.csv");
  addToSeen(file, [{ url: "https://www.example.com/in/example-jane-doe", name: "Jane Doe", firstSeen: "2026-10-21", id: 1 }]);
  // Another sourcer adds someone to the same file in between.
  addToSeen(file, [{ url: "https://www.example.com/in/example-sam", name: "Sam", firstSeen: "2026-10-21", id: 2 }]);
  addToSeen(file, [{ url: "", name: "No URL", firstSeen: "2026-10-21", id: 3 }]);
  const seen = loadSeen(file);
  assert.equal(seen.byUrl.size, 2);
  assert.deepEqual([...seen.ids].sort(), [1, 2, 3]);
  assert.match(readFileSync(file, "utf8"), /^\uFEFFprofile URL,name,first seen,crustdata person id\n/);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(loadSeen(join(dir, "missing.csv")).byUrl.size, 0);
});

test("CSV cells: quoting, no spreadsheet formulas, a BOM for Excel", () => {
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-3), "-3");
  assert.deepEqual(parseCsv('\uFEFFa,"b, c"\r\n"d ""e""",f\n'), [["a", "b, c"], ['d "e"', "f"]]);
  const dir = mkdtempSync(join(tmpdir(), "csv-"));
  writeCsv(join(dir, "x.csv"), ["name"], [["王小明"]]);
  assert.ok(readFileSync(join(dir, "x.csv"), "utf8").startsWith("\uFEFFname\n"));
});

test("two runs writing one shared seen list at the same moment lose nobody", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "seen-race-"));
  const file = join(dir, "team-seen.csv");
  const seenModule = new URL("../src/seen.ts", import.meta.url).href;
  const writer = (tag: string) => new Promise<void>((resolve, reject) => {
    const code = `const { addToSeen } = await import(${JSON.stringify(seenModule)});
      for (let i = 0; i < 100; i++) addToSeen(${JSON.stringify(file)}, [{ url: "https://www.example.com/in/example-${tag}-" + i, name: "", firstSeen: "", id: undefined }]);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: "inherit" });
    child.on("exit", c => (c === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${c}`))));
  });
  await Promise.all([writer("a"), writer("b")]);
  assert.equal(loadSeen(file).byUrl.size, 200);
});
