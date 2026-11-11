import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runVerify, resolveIdentify, parseFlags } from "../src/verify.js";
import { runForget } from "../src/forget.js";
import { parseCsv } from "../src/input.js";
import { example, fixture, offline, quiet } from "./helpers.js";

process.env.CVA_NO_DOTENV = "1";
const rowsOf = (out: string, list = "ashby-export") => parseCsv(readFileSync(join(out, list, "verified.csv"), "utf8"));
const col = (rows: ReturnType<typeof parseCsv>, name: string) => { const i = rows[0].cells.indexOf(name); return rows.slice(1).map(r => r.cells[i]); };

test("full check, end to end: every verdict, sorted doubtful first, the file kept whole", async () => {
  const { out, count } = offline(fixture("mixed-list.json"));
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const rows = rowsOf(out);
  assert.deepEqual(col(rows, "verdict"), ["clearly_fabricated", "probably_fabricated", "reclassified_employment", "non_person", "cannot_verify", "not_checked", "not_checked", "probably_genuine", "probably_genuine", "clearly_genuine", "clearly_genuine"]);
  // The repeated row (one row per application) is kept, with the same verdict, checked once.
  assert.deepEqual(col(rows, "review_rank"), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(rows[1].cells[0], "Sam Testcase");
  // Original columns first, unchanged; the row with nothing to check is kept with its reason.
  assert.deepEqual(rows[0].cells.slice(0, 6), ["Name", "Email", "LinkedIn URL", "Job", "Current Stage", "Source"]);
  assert.match(col(rows, "summary").join("\n"), /No profile URL or email in this row/);
  assert.equal(col(rows, "profile_url_checked").filter(Boolean).length, 10);
  // Casey had only an email: looked up, then verified.
  assert.ok(col(rows, "checked_name").includes("Casey Emailonly"));
  assert.equal(count("/person/identify"), 1);
  assert.equal(count("/person/enrich"), 1);
  assert.equal(count("/batch/person/verify"), 1);
  assert.ok(existsSync(join(out, "ashby-export", "report.md")));
  assert.ok(existsSync(join(out, "ashby-export", "unresolved.csv")));
  assert.match(output, /10 candidates: 8 checked, 4 to review first or clarify in the screen/);
  assert.match(output, /80 of them for 8 verdicts/);
});

test("the same people on another list are not paid for again", async () => {
  const { out, calls } = offline(fixture("mixed-list.json"));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const { output } = await quiet(() => runVerify([example("lever-export.csv"), "--yes"]));
  // Only the profile that got no verdict (free) is tried again.
  const submits = calls.filter(c => c.path === "/batch/person/verify").map(c => c.body.professional_network_profile_urls);
  assert.deepEqual(submits[1], ["https://www.linkedin.com/in/example-riley-gone-404"]);
  const enriched = calls.filter(c => c.path === "/person/enrich").map(c => c.body.professional_network_profile_urls);
  assert.deepEqual(enriched[1], ["https://www.linkedin.com/in/example-riley-gone-404"]);
  assert.match(output, /Reused from the last 30 days: at least 7 people/);
  assert.deepEqual(col(rowsOf(out, "lever-export"), "verdict").slice(0, 2), ["clearly_fabricated", "probably_fabricated"]);
  // --refresh checks them again.
  await quiet(() => runVerify([example("lever-export.csv"), "--yes", "--refresh"]));
  assert.equal(calls.filter(c => c.path === "/batch/person/verify").at(-1)!.body.professional_network_profile_urls.length, 9);
});

test("dry run: free calls only, nothing written", async () => {
  const { out, calls } = offline(fixture("mixed-list.json"));
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--dry-run"]));
  assert.deepEqual([...new Set(calls.map(c => c.path))], ["/account/endpoints"]);
  assert.match(output, /Total: at most 100 credits/);
  assert.equal(existsSync(join(out, "ashby-export")), false);
});

test("a key without the add-on runs the quick screen; --full refuses", async () => {
  const fx = { ...fixture("mixed-list.json"), access: { verify: false } };
  const { out, count } = offline(fx);
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(output, /does not have the full check/);
  assert.equal(count("/batch/person/verify"), 0);
  const rows = rowsOf(out);
  assert.deepEqual(new Set(col(rows, "check_type")), new Set(["quick", "none"]));
  // Alex's profile has a full-time job during a full-time master's: moved up with the reason.
  assert.match(col(rows, "reasons").join("\n"), /Senior Engineer at Hooli Example \(2018 to 2019\) overlaps Master of Science/);
  await assert.rejects(() => quiet(() => runVerify([example("ashby-export.csv"), "--full", "--yes"])), /does not have the full check/);
});

test("no assessment field and no email lookup: date check only, email rows explained", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), access: { verify: false, assessment: false, identify: false } });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/person/identify"), 0);
  const rows = rowsOf(out);
  assert.match(col(rows, "summary").join("\n"), /cannot look up emails/);
  assert.ok(col(rows, "verdict").every(v => v === "not_checked"));
});

test("jobs still running when time is up are collected by the next run, never sent twice", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), polls: 12 });
  const first = await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  assert.match(first.output, /still in running or held jobs/);
  assert.equal(count("/batch/person/verify"), 1);
  const state = JSON.parse(readFileSync(join(out, "ashby-export", "state.json"), "utf8"));
  assert.equal(state.jobs.length, 1);
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/batch/person/verify"), 1, "the saved job was polled, not resubmitted");
  assert.equal(col(rowsOf(out), "verdict")[0], "clearly_fabricated");
});

test("a failed job is sent once more (failed jobs are free); two failures mark people not checked", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), failJobs: 1 });
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(output, /sent again/);
  assert.equal(count("/batch/person/verify"), 2);
  assert.equal(col(rowsOf(out), "verdict")[0], "clearly_fabricated");

  const twice = offline({ ...fixture("mixed-list.json"), failJobs: 2 });
  const second = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(second.output, /failed twice/);
  assert.equal(twice.count("/batch/person/verify"), 2);
  // The quick verdict from the profile details stands in, labelled as such.
  assert.match(col(rowsOf(twice.out), "summary").join("\n"), /Quick screen/);
});

test("long lists are split into jobs of 10, at most 5 at once", async () => {
  const fx = fixture("mixed-list.json");
  const header = "Name,Profile URL\n";
  const lines = Array.from({ length: 73 }, (_, i) => `Person ${i},https://www.linkedin.com/in/example-person-${i}`);
  const { out, calls } = offline(fx);
  const file = join(out, "big.csv");
  writeFileSync(file, header + lines.join("\n"));
  await quiet(() => runVerify([file, "--yes"]));
  const submits = calls.filter(c => c.path === "/batch/person/verify");
  assert.equal(submits.length, 8);
  assert.ok(submits.every(s => s.body.professional_network_profile_urls.length <= 10));
  assert.equal(new Set(submits.flatMap(s => s.body.professional_network_profile_urls)).size, 73);
  assert.equal(calls.filter(c => c.path === "/person/enrich").length, 3);
});

test("billing: a lost submit answer holds the people; the next run sends again only when no job was created", async () => {
  for (const status of [500, 502, 503]) {
    const { count } = offline({ ...fixture("mixed-list.json"), faults: [{ path: "/batch/person/verify", call: 1, status }] });
    const first = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
    assert.match(first.output, /To avoid paying twice/);
    assert.equal(count("/batch/person/verify"), 1, `${status} is never retried at once`);
    const second = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
    assert.equal(count("/batch/"), 1, "the next run asks Crustdata first");
    assert.equal(count("/batch/person/verify"), 2, "no job was created, so sending again is safe");
    assert.match(second.output, /10 candidates: 8 checked, 4 to review/);
  }
});

test("billing: a job created before its answer was lost is found and read, never sent again", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), polls: 0, faults: [{ path: "/batch/person/verify", call: 1, status: 500, after: true }] });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(output, /Found the job for an earlier submission/);
  assert.equal(count("/batch/person/verify"), 1, "one job, one bill");
  assert.equal(col(rowsOf(out), "verdict")[0], "clearly_fabricated");
});

test("billing: a colleague's job of the same size is never taken for ours", async () => {
  const fx = fixture("mixed-list.json");
  const theirs = Array.from({ length: 9 }, (_, i) => `https://www.linkedin.com/in/example-colleague-${i}`);
  for (const u of theirs) fx.verify![u] = { verdict: "clearly_genuine", confidence: 0.9 };
  const { count } = offline({ ...fx, otherJobs: [{ urls: theirs }], faults: [{ path: "/batch/person/verify", call: 1, status: 500 }] });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/batch/person/verify"), 2, "their job holds other people, so ours was sent once more");
});

test("billing: while a matching job is still running, or the job list cannot be read, nothing is sent again", async () => {
  const fx = fixture("mixed-list.json");
  const { count } = offline({ ...fx, otherJobs: [{ urls: Array.from({ length: 9 }, (_, i) => `https://www.linkedin.com/in/example-c-${i}`), status: "processing" }], faults: [{ path: "/batch/person/verify", call: 1, status: 500 }, { path: "/batch/", call: 2, status: 500 }] });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const second = await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  assert.match(second.output, /held until Crustdata shows that job/);
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  assert.equal(count("/batch/person/verify"), 1);
});

test("billing: a run that stops mid-submit leaves a record, and the next run checks before sending", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), polls: 0 });
  // Simulate a crash: the submit reaches Crustdata (the job exists) but the process dies before the answer.
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const res = await real(input, init);
    if (String(input).endsWith("/batch/person/verify")) throw new Error("process killed");
    return res;
  }) as typeof fetch;
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  globalThis.fetch = real;
  const state = JSON.parse(readFileSync(join(out, "ashby-export", "state.json"), "utf8"));
  assert.equal(state.pending.length, 1, "the submission was saved before it was sent");
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/batch/person/verify"), 1, "found, not sent again");
});

test("billing: people in another list's running job are not sent again", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), polls: 1000 });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  const { output } = await quiet(() => runVerify([example("lever-export.csv"), "--yes", "--wait", "1"]));
  assert.match(output, /already in a running job of another list \(ashby-export\)/);
  assert.equal(count("/batch/person/verify"), 1);
  assert.match(col(rowsOf(out, "lever-export"), "summary").join("\n"), /Being checked in the list "ashby-export"/);
});

test("billing: a state file from another version is never replaced", async () => {
  const { out, count } = offline(fixture("mixed-list.json"));
  mkdirSync(join(out, "ashby-export"), { recursive: true });
  writeFileSync(join(out, "ashby-export", "state.json"), JSON.stringify({ version: 2, jobs: [{ batchId: "x", urls: [] }] }));
  await assert.rejects(() => quiet(() => runVerify([example("ashby-export.csv"), "--yes"])), /another version/);
  assert.equal(count("/batch/person/verify"), 0);
});

test("email lookups are saved by the email sent, so a differently spelt answer is not paid for twice", async () => {
  const fx = fixture("mixed-list.json");
  fx.identify!["casey.emailonly@example.com"].matched_on = "  Casey.EmailOnly@Example.com ";
  const { count } = offline(fx);
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--refresh"]));
  assert.equal(count("/person/identify"), 1);
});

test("invalid emails: rejected addresses are taken out whatever the message format", async () => {
  const { calls } = offline({ ...fixture("mixed-list.json"), faults: [{ path: "/person/identify", call: 1, status: 400, message: "Invalid emails: ['casey.emailonly@example.com']" }] });
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(calls.filter(c => c.path === "/person/identify").length, 1);
  assert.match(output, /could not be checked/);
});

test("spending above the limit needs --yes without a terminal", async () => {
  offline(fixture("mixed-list.json"));
  await assert.rejects(() => quiet(() => runVerify([example("ashby-export.csv")])), /Add --yes/);
});

test("errors are plain: 401, 402, a 429 that does not clear", async () => {
  offline({ ...fixture("mixed-list.json"), faults: [{ path: "/account/endpoints", call: 1, status: 401 }] });
  await assert.rejects(() => quiet(() => runVerify([example("ashby-export.csv"), "--yes"])), /rejected the API key/);
  offline({ ...fixture("mixed-list.json"), faults: [{ path: "/person/enrich", call: 1, status: 402, message: "Insufficient credits" }] });
  await assert.rejects(() => quiet(() => runVerify([example("ashby-export.csv"), "--yes"])), /out of credits/);
});

test("Slack: one summary, names escaped, posted only when a webhook is set", async () => {
  const posts: any[] = [];
  const fx = fixture("mixed-list.json");
  fx.people["https://www.linkedin.com/in/example-sam-testcase"].experience!.employment_details!.current![0].title = "<!channel> Director";
  offline(fx, (url, init) => (url.hostname === "hooks.slack.com" ? (posts.push(JSON.parse(String(init?.body))), new Response("ok")) : undefined));
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/XXXX";
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(output, /Posted the summary to Slack/);
  assert.equal(posts.length, 1);
  const text = JSON.stringify(posts[0]);
  assert.ok(!text.includes("<!channel>"));
  assert.ok(text.includes("&lt;!channel&gt; Director"));
  assert.match(text, /4 to review first or clarify/);
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--no-slack"]));
  assert.equal(posts.length, 1);
  delete process.env.SLACK_WEBHOOK_URL;
});

test("forget removes a person from every output file", async () => {
  const { out } = offline(fixture("mixed-list.json"));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const url = "https://www.linkedin.com/in/example-sam-testcase";
  await quiet(() => runForget([url.toUpperCase()]));
  for (const f of ["checked.json", "ashby-export/state.json", "ashby-export/results.json", "ashby-export/verified.csv", "ashby-export/report.md"]) {
    assert.ok(!readFileSync(join(out, f), "utf8").toLowerCase().includes("example-sam-testcase"), f);
  }
  assert.ok(readFileSync(join(out, "ashby-export/verified.csv"), "utf8").includes("example-priya-example"));
});

test("email lookups use only one exact match", () => {
  const m = (score: number, url = "https://www.linkedin.com/in/example-a") => ({ confidence_score: score, person_data: { social_handles: { professional_network_identifier: { profile_url: url } } } });
  assert.equal(resolveIdentify({ match_status: "matched", matches: [m(1)] }).url, "https://www.linkedin.com/in/example-a");
  assert.match(resolveIdentify({ match_status: "matched", matches: [m(0.7)] }).problem!, /loosely/);
  assert.match(resolveIdentify({ match_status: "matched", matches: [m(1), m(1, "https://www.linkedin.com/in/example-b")] }).problem!, /more than one/);
  assert.match(resolveIdentify({ match_status: "not_found", matches: [] }).problem!, /No profile found/);
});

test("flags: plain errors for typos", () => {
  assert.throws(() => parseFlags(["a.csv", "--limt", "3"]), /Unknown option --limt/);
  assert.throws(() => parseFlags(["a.csv", "--limit", "0"]), /whole number/);
  assert.throws(() => parseFlags(["a.csv", "b.csv"]), /One file at a time/);
  assert.throws(() => parseFlags(["a.csv", "--quick", "--full"]), /Pick one/);
});

test("the same person under two profile URLs is verified once", async () => {
  const fx = fixture("mixed-list.json");
  fx.people["https://www.linkedin.com/in/example-priya-old-slug"] = fx.people["https://www.linkedin.com/in/example-priya-example"];
  const { out, calls } = offline(fx);
  const file = join(out, "two.csv");
  writeFileSync(file, "Name,Profile URL\nPriya,https://www.linkedin.com/in/example-priya-example\nPriya again,https://www.linkedin.com/in/example-priya-old-slug\n");
  const { output } = await quiet(() => runVerify([file, "--yes"]));
  assert.match(output, /1 row turned out to be the same person/);
  const sent = calls.filter(c => c.path === "/batch/person/verify").flatMap(c => c.body.professional_network_profile_urls);
  assert.deepEqual(sent, ["https://www.linkedin.com/in/example-priya-example"]);
  const rows = rowsOf(out, "two");
  assert.deepEqual(col(rows, "verdict"), ["clearly_genuine", "clearly_genuine"]);
  const j = col(rows, "Name").indexOf("Priya again");
  assert.match(col(rows, "summary")[j] + col(rows, "reasons")[j], /Same person as line 2/);
});

test("npm options without -- are refused before anything runs", () => {
  assert.throws(() => parseFlags(["a.csv"], { npm_config_dry_run: "true" }), /Put -- before your file/);
  assert.equal(parseFlags(["a.csv", "--dry-run"], {}).dryRun, true);
});

test("a name that differs from the file is flagged and moved to the first-call questions", async () => {
  const fx = fixture("mixed-list.json");
  const { out } = offline(fx);
  const file = join(out, "names.csv");
  writeFileSync(file, "Name,Profile URL\nSomeone Else,https://www.linkedin.com/in/example-priya-example\nPriya,https://www.linkedin.com/in/example-sam-testcase\n");
  await quiet(() => runVerify([file, "--yes"]));
  const rows = rowsOf(out, "names");
  const i = col(rows, "Name").indexOf("Someone Else");
  assert.equal(col(rows, "review_group")[i], "Ask in the first call");
  assert.match(col(rows, "summary")[i], /The name on the profile \("Priya Example"\) is not the name in your file \("Someone Else"\)/);
});

test("an email match whose profile name differs from the file is not used", async () => {
  const fx = fixture("mixed-list.json");
  const { out } = offline(fx);
  const file = join(out, "email.csv");
  writeFileSync(file, "Name,Email\nRobin Other,casey.emailonly@example.com\n");
  await quiet(() => runVerify([file, "--yes"]));
  assert.match(col(rowsOf(out, "email"), "summary")[0], /under another name \("Casey Emailonly", not "Robin Other"\)/);
});

test("MAX_CREDITS_PER_RUN stops a run even with --yes; the run log records runs", async () => {
  const { out, count } = offline(fixture("mixed-list.json"));
  process.env.MAX_CREDITS_PER_RUN = "20";
  await assert.rejects(() => quiet(() => runVerify([example("ashby-export.csv"), "--yes"])), /MAX_CREDITS_PER_RUN/);
  assert.equal(count("/person/enrich"), 0);
  delete process.env.MAX_CREDITS_PER_RUN;
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(readFileSync(join(out, "runs.csv"), "utf8"), /^at,user,file,list,check,candidates,credits\n.*,ashby-export\.csv,ashby-export,full,10,89\n$/s);
});

test("forget by email removes the person and rebuilds the report counts", async () => {
  const { out } = offline(fixture("mixed-list.json"));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  await quiet(() => runForget(["sam.testcase@example.com"]));
  const report = readFileSync(join(out, "ashby-export/report.md"), "utf8");
  assert.ok(!/Sam Testcase|example-sam/i.test(report), "no trace of Sam in the report");
  assert.match(report, /Review first \(1\)/);
  assert.ok(!readFileSync(join(out, "checked.json"), "utf8").includes("example-sam-testcase"));
  assert.ok(!readFileSync(join(out, "ashby-export/verified.csv"), "utf8").includes("sam.testcase@example.com"));
});

test("purge deletes old lists and old results only", async () => {
  const { out } = offline(fixture("mixed-list.json"));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const { runPurge } = await import("../src/forget.js");
  await quiet(() => runPurge(["--older-than", "30"]));
  assert.ok(existsSync(join(out, "ashby-export")));
  await quiet(() => runPurge(["--older-than", "0"], Date.now() + 86_400_000));
  assert.ok(!existsSync(join(out, "ashby-export")));
  assert.equal(readFileSync(join(out, "checked.json"), "utf8").trim(), "{}");
});

test("billing: a colleague's job that holds some of our people is not adopted", async () => {
  const fx = fixture("mixed-list.json");
  const ours = ["https://www.linkedin.com/in/example-priya-example", "https://www.linkedin.com/in/example-marcus-sample", "https://www.linkedin.com/in/example-sam-testcase"];
  const theirs = [...ours, ...Array.from({ length: 6 }, (_, i) => `https://www.linkedin.com/in/example-other-${i}`)];
  const { count } = offline({ ...fx, otherJobs: [{ urls: theirs, agoMinutes: 30 }], faults: [{ path: "/batch/person/verify", call: 1, status: 500 }] });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const second = await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  assert.match(second.output, /held until Crustdata shows that job/, "it cannot be told apart, so nothing is sent and nothing is adopted");
  assert.equal(count("/batch/person/verify"), 1);
});

test("billing: while any matching job still runs, nothing older is adopted", async () => {
  const { resolveLostSubmit } = await import("../src/crustdata.js");
  const fx = fixture("mixed-list.json");
  const urls = ["https://www.linkedin.com/in/example-priya-example", "https://www.linkedin.com/in/example-sam-testcase"];
  offline({ ...fx, otherJobs: [{ urls, agoMinutes: 60 }, { urls: ["https://www.linkedin.com/in/example-x", "https://www.linkedin.com/in/example-y"], status: "processing" }] });
  const { normalizeProfileUrl } = await import("../src/profile-url.js");
  assert.equal(await resolveLostSubmit(urls, Date.parse("2026-11-11T12:00:00Z"), new Set(), (a, b) => normalizeProfileUrl(a) === b), "unsure");
});

test("billing: a finished job whose results are not complete is kept and read again, never marked no verdict", async () => {
  const fx = fixture("mixed-list.json");
  const { out, count } = offline({ ...fx, polls: 0 });
  const real = globalThis.fetch;
  let cut = true;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (cut && String(input).includes("crustdata-batch-api-data")) { cut = false; return new Response(Buffer.alloc(0), { status: 200 }); }
    return real(input, init);
  }) as typeof fetch;
  const first = await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  assert.match(first.output, /not complete yet/);
  const state = JSON.parse(readFileSync(join(out, "ashby-export", "state.json"), "utf8"));
  assert.equal(Object.keys(state.verified).length, 0, "nobody marked no verdict");
  globalThis.fetch = real;
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/batch/person/verify"), 1);
  assert.equal(col(rowsOf(out), "verdict")[0], "clearly_fabricated");
});

test("forget while a job runs: the record is dropped, never given to someone else", async () => {
  const { out } = offline({ ...fixture("mixed-list.json"), polls: 1000 });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  await quiet(() => runForget(["https://www.linkedin.com/in/example-sam-testcase"]));
  const state = JSON.parse(readFileSync(join(out, "ashby-export", "state.json"), "utf8"));
  assert.deepEqual(state.forgotten, ["https://www.linkedin.com/in/example-sam-testcase"]);
  assert.equal(state.jobs[0].urls.length, 9, "a running job's people are not edited");
});

test("purge keeps a list whose job is still running", async () => {
  const { out } = offline({ ...fixture("mixed-list.json"), polls: 1000 });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  const { runPurge } = await import("../src/forget.js");
  const { output } = await quiet(() => runPurge(["--older-than", "0"], Date.now() + 86_400_000));
  assert.match(output, /Kept ashby-export: jobs still running/);
  assert.ok(existsSync(join(out, "ashby-export", "state.json")));
});

test("billing: a held submission sent again respects --limit", async () => {
  const { calls } = offline({ ...fixture("mixed-list.json"), faults: [{ path: "/batch/person/verify", call: 1, status: 500 }] });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--limit", "3"]));
  const last = calls.filter(c => c.path === "/batch/person/verify").at(-1)!;
  assert.equal(last.body.professional_network_profile_urls.length, 3);
});

test("a job that answers 404 once is not given up; status outages and unknown statuses do not stop or lose anything", async () => {
  const { out, count } = offline({ ...fixture("mixed-list.json"), polls: 3, faults: [{ path: "/batch/{id}", call: 1, status: 404 }, { path: "/batch/{id}", call: 2, status: 500 }, { path: "/batch/{id}", call: 3, status: 502 }] });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/batch/person/verify"), 1);
  assert.equal(col(rowsOf(out), "verdict")[0], "clearly_fabricated");
});

test("borrowed profiles: the same profile URL under two names is not merged", async () => {
  const { out } = offline(fixture("mixed-list.json"));
  const file = join(out, "borrowed.csv");
  writeFileSync(file, "Name,Profile URL\nPriya Example,https://www.linkedin.com/in/example-priya-example\nRahul Other,https://www.linkedin.com/in/example-priya-example\n");
  await quiet(() => runVerify([file, "--yes"]));
  const rows = rowsOf(out, "borrowed");
  const i = col(rows, "Name").indexOf("Rahul Other");
  assert.equal(col(rows, "verdict")[i], "not_checked");
  assert.match(col(rows, "summary")[i], /same profile URL under another name/);
});

test("old progress is not reused as new: a list run again months later is checked again and dated right", async () => {
  const { out, count } = offline(fixture("mixed-list.json"));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const { clock } = await import("../src/crustdata.js");
  const later = clock.now() + 120 * 86_400_000;
  clock.now = () => later;
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.equal(count("/batch/person/verify"), 2);
  assert.match(output, /80 of them for 8 verdicts/);
  void out;
});

test("--no-slack without -- is refused", () => {
  assert.throws(() => parseFlags(["a.csv"], { npm_config_slack: "" }), /--no-slack/);
});

test("forget while a job runs: the person is not sent again on later runs, and leaves state once the job is read", async () => {
  const { out, calls } = offline({ ...fixture("mixed-list.json"), polls: 30 });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  await quiet(() => runForget(["https://www.linkedin.com/in/example-sam-testcase"]));
  for (let i = 0; i < 3; i++) await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const sent = calls.filter(c => c.path === "/batch/person/verify").flatMap(c => c.body.professional_network_profile_urls);
  assert.equal(sent.filter((u: string) => u.includes("sam-testcase")).length, 1, "only the original job");
  const state = JSON.parse(readFileSync(join(out, "ashby-export", "state.json"), "utf8"));
  assert.ok(!JSON.stringify(state.verified).includes("sam-testcase"));
});

test("REUSE_VERDICTS_DAYS=0 never makes a list pay twice for its own progress", async () => {
  const { count } = offline({ ...fixture("mixed-list.json"), polls: 30 });
  process.env.REUSE_VERDICTS_DAYS = "0";
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  delete process.env.REUSE_VERDICTS_DAYS;
  assert.equal(count("/batch/person/verify"), 1);
  assert.equal(count("/person/enrich"), 1);
});

test("a failed job's retry leaves out a forgotten person", async () => {
  const { calls } = offline({ ...fixture("mixed-list.json"), failJobs: 1, polls: 30 });
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  await quiet(() => runForget(["https://www.linkedin.com/in/example-sam-testcase"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const retry = calls.filter(c => c.path === "/batch/person/verify")[1];
  assert.ok(!retry.body.professional_network_profile_urls.some((u: string) => u.includes("sam-testcase")));
});

test("the same person under two URL spellings across lists is checked once", async () => {
  const fx = fixture("mixed-list.json");
  fx.people["https://www.linkedin.com/in/example-priya-new-slug"] = fx.people["https://www.linkedin.com/in/example-priya-example"];
  const { out, calls } = offline(fx);
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  const file = join(out, "other.csv");
  writeFileSync(file, "Name,Profile URL\nPriya Example,https://www.linkedin.com/in/example-priya-new-slug\n");
  await quiet(() => runVerify([file, "--yes"]));
  const sent = calls.filter(c => c.path === "/batch/person/verify").flatMap(c => c.body.professional_network_profile_urls);
  assert.ok(!sent.includes("https://www.linkedin.com/in/example-priya-new-slug"));
  assert.equal(col(rowsOf(out, "other"), "verdict")[0], "clearly_genuine");
});

test("an unreadable line in a results file is not counted as read", async () => {
  const fx = fixture("mixed-list.json");
  const { out } = offline({ ...fx, polls: 0 });
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const res = await real(input, init);
    if (!String(input).includes("crustdata-batch-api-data")) return res;
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const lines = gunzipSync(Buffer.from(await res.arrayBuffer())).toString().split("\n");
    lines[0] = "{broken";
    return new Response(gzipSync(Buffer.from(lines.join("\n"))), { status: 200 });
  }) as typeof fetch;
  const { output } = await quiet(() => runVerify([example("ashby-export.csv"), "--yes", "--wait", "1"]));
  globalThis.fetch = real;
  assert.match(output, /not complete yet/);
  const state = JSON.parse(readFileSync(join(out, "ashby-export", "state.json"), "utf8"));
  assert.equal(Object.keys(state.verified).length, 0);
});

test("billing: a run stopped part way (402 on a later submit, a crash while polling) never sends anyone twice", async () => {
  const lines = Array.from({ length: 33 }, (_, i) => `Person ${i},https://www.linkedin.com/in/example-person-${i}`);
  const noDupes = (calls: Array<{ path: string; body: any }>, refused: number[] = []) => {
    // Submits that were refused (the 402) created no job and billed nothing.
    const sent = calls.filter(c => c.path === "/batch/person/verify").filter((_, i) => !refused.includes(i + 1)).flatMap(c => c.body.professional_network_profile_urls);
    assert.equal(new Set(sent).size, sent.length, `sent twice: ${sent.length - new Set(sent).size}`);
    return sent.length;
  };
  // 402 on the second submit, then a rerun.
  {
    const { out, calls } = offline({ ...fixture("mixed-list.json"), polls: 5, faults: [{ path: "/batch/person/verify", call: 2, status: 402, message: "Insufficient credits" }] });
    const file = join(out, "big.csv");
    writeFileSync(file, "Name,Profile URL\n" + lines.join("\n"));
    await assert.rejects(() => quiet(() => runVerify([file, "--yes"])), /out of credits/);
    await quiet(() => runVerify([file, "--yes"]));
    assert.equal(noDupes(calls, [2]), 33);
  }
  // A crash while polling (the process dies in the middle of the run), then a rerun.
  {
    const { out, calls } = offline({ ...fixture("mixed-list.json"), polls: 5 });
    const file = join(out, "big.csv");
    writeFileSync(file, "Name,Profile URL\n" + lines.join("\n"));
    const { clock } = await import("../src/crustdata.js");
    const sleep = clock.sleep;
    let n = 0;
    clock.sleep = async ms => { if (++n === 3) throw new Error("killed"); return sleep(ms); };
    await assert.rejects(() => quiet(() => runVerify([file, "--yes"])), /killed/);
    clock.sleep = sleep;
    const state = JSON.parse(readFileSync(join(out, "big", "state.json"), "utf8"));
    assert.equal(state.pending.length, 0, "no leftover pending entry");
    assert.ok(state.jobs.length >= 1);
    await quiet(() => runVerify([file, "--yes"]));
    assert.equal(noDupes(calls), 33);
  }
});

test("--ai: no request to Anthropic carries a name from the list, a profile URL, or a row with no verdict", async () => {
  const bodies: string[] = [];
  const reply = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Evidence supports the role." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  const { out } = offline(fixture("mixed-list.json"), (url, init) => {
    if (url.hostname !== "api.anthropic.com") return undefined;
    bodies.push(String(init?.body));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  const file = join(out, "ai.csv");
  writeFileSync(file, "Name,Email,Profile URL\nPriya Example,,https://www.linkedin.com/in/example-priya-example\nRahul Other,,https://www.linkedin.com/in/example-priya-example\nRobin Other,casey.emailonly@example.com,\nSam Testcase,,https://www.linkedin.com/in/example-sam-testcase\n");
  await quiet(() => runVerify([file, "--yes", "--ai"]));
  delete process.env.ANTHROPIC_API_KEY;
  assert.ok(bodies.length >= 2, "the AI was called");
  const all = bodies.join("\n");
  for (const leak of ["Priya", "priya-example", "Rahul", "Casey", "Robin", "Sam Testcase", "Testcase", "linkedin.com/in"]) assert.ok(!all.includes(leak), `leaked ${leak}`);
});

test("forget by email, then --undo by profile URL, allows the person again", async () => {
  const { out } = offline(fixture("mixed-list.json"));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  await quiet(() => runForget(["sam.testcase@example.com"]));
  const blocked = await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.match(col(rowsOf(out), "summary").join("\n"), /Removed with npm run forget/);
  await quiet(() => runForget(["https://www.linkedin.com/in/example-sam-testcase", "--undo"]));
  await quiet(() => runVerify([example("ashby-export.csv"), "--yes"]));
  assert.ok(!col(rowsOf(out), "summary").join("\n").includes("Removed with npm run forget"));
  void blocked;
});
