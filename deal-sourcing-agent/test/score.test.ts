import { test } from "node:test";
import assert from "node:assert/strict";
import { WEIGHTS, momentum, monthsSince, scoreDeal, stageName, timingOf } from "../src/score.js";
import type { Company, Jobs, Posts } from "../src/types.js";

const today = new Date("2026-10-21T12:00:00Z");
const company = (over: Partial<Company> = {}): Company => ({ id: 1, name: "Fakeco", domain: "fakeco.example", investors: [], ...over });
const jobs = (last90: number | null = 0): Jobs => ({ last90, last30: last90, newest: [] });
const posts = (traction: number | null = 0, raise: number | null = 0): Posts => ({ traction, raise, quotes: [] });
const spec = { timing: "due" as const };

test("weights add up to 100, founders first", () => {
  const w = WEIGHTS;
  assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100);
  const founders = w.repeatFounder + w.foundersFrom + w.schools;
  const growth = w.headcount6m + w.headcount3m + w.followers6m;
  assert.ok(founders > growth && growth > w.hiring && w.hiring > w.fit);
});

test("months since a date", () => {
  assert.equal(monthsSince("2025-01-15", today), 21);
  assert.equal(monthsSince("2025-10-22", today), 11);
  assert.equal(monthsSince("2025-10-21", today), 12);
});

test("due and growing: a round 12 to 24 months ago with two signs of growth earns full timing", () => {
  const c = company({ lastRound: "seed", lastRoundDate: "2025-03-10", growth6m: 40, added6m: 4 });
  const t = timingOf(c, jobs(5), posts(0), "due", today);
  assert.equal(t.timing.label, "Due and growing");
  assert.equal(t.points, WEIGHTS.timing);
});

test("due but quiet: raised 21 months ago, team shrinking, no roles, no posts: no timing points, and it says why", () => {
  const c = company({ lastRound: "seed", lastRoundDate: "2025-01-15", growth6m: -27.3, added6m: -3 });
  const t = timingOf(c, jobs(0), posts(0), "due", today);
  assert.equal(t.timing.label, "Due but quiet");
  assert.equal(t.points, 0);
  assert.match(t.timing.explain, /team -27% in 6 months/);
  assert.match(t.timing.explain, /no roles posted in 90 days/);
});

test("a shrinking team cancels a sign of growth", () => {
  const c = company({ lastRound: "seed", lastRoundDate: "2025-01-15", growth6m: -15, followers6m: 40 });
  const m = momentum(c, jobs(0), posts(0));
  assert.equal(m.signs.length, 1);
  assert.equal(m.shrinking, true);
  assert.equal(m.level, 0);
  assert.equal(timingOf(c, jobs(0), posts(0), "due", today).timing.label, "Due but quiet");
});

test("one sign of growth is half the timing points; edges of the window are half again", () => {
  const due = timingOf(company({ lastRoundDate: "2025-03-10", growth6m: 12, added6m: 2 }), jobs(0), posts(0), "due", today);
  assert.equal(due.timing.label, "Due, some growth");
  assert.equal(due.points, WEIGHTS.timing / 2);
  const past = timingOf(company({ lastRoundDate: "2024-06-01", growth6m: 40, added6m: 4 }), jobs(4), posts(0), "due", today);
  assert.equal(past.timing.label, "Past due and growing");
  assert.equal(past.points, WEIGHTS.timing / 2);
  assert.equal(timingOf(company({ lastRoundDate: "2026-04-01" }), jobs(9), posts(3), "due", today).timing.label, "Raised recently");
  assert.equal(timingOf(company({ lastRoundDate: "2023-01-01" }), jobs(9), posts(3), "due", today).points, 0);
});

test("a founder post about a round overrides an old round date", () => {
  const c = company({ lastRound: "seed", lastRoundDate: "2024-06-01" });
  const due = timingOf(c, jobs(4), posts(0, 1), "due", today);
  assert.equal(due.timing.label, "May have just raised");
  assert.equal(due.points, 0);
  assert.equal(timingOf(c, jobs(4), posts(0, 1), "fresh", today).points, WEIGHTS.timing);
  // A raise post right after a recent round is just that round: no override.
  assert.equal(timingOf(company({ lastRoundDate: "2026-08-01" }), jobs(0), posts(0, 1), "due", today).timing.label, "Raised recently");
});

test("fresh and off modes; no round on record is not scored", () => {
  assert.equal(timingOf(company({ lastRoundDate: "2026-06-01" }), jobs(), posts(), "fresh", today).timing.label, "Just raised");
  assert.equal(timingOf(company({ lastRoundDate: "2026-06-01" }), jobs(), posts(), "off", today).points, undefined);
  assert.equal(timingOf(company(), jobs(), posts(), "due", today).points, undefined);
});

test("signals that do not apply are left out of the total, not counted as zero", () => {
  const s = scoreDeal(company({ lastRound: "seed", lastRoundDate: "2025-03-10" }), [], jobs(null), posts(null), spec, today);
  const keys = s.signals.map(x => x.key);
  assert.ok(!keys.includes("headcount6m") && !keys.includes("hiring") && !keys.includes("traction") && !keys.includes("schools"));
  assert.ok(s.notScored.some(n => /no headcount history/.test(n)));
  assert.ok(s.notScored.some(n => /--schools/.test(n)));
  assert.ok(s.total >= 0 && s.total <= 100);
});

test("a shrinking team earns no growth points, and the score stays between 0 and 100", () => {
  const s = scoreDeal(company({ growth6m: -50, growth3m: -40, followers6m: -10, headcount: 4, added6m: -4 }), [], jobs(0), posts(0), spec, today);
  for (const sig of s.signals) assert.ok(sig.points >= 0 && sig.points <= sig.max, sig.key);
  assert.equal(s.signals.find(x => x.key === "headcount6m")!.points, 0);
  assert.match(s.signals.find(x => x.key === "headcount6m")!.reason, /from 8 to 4 people/);
});

test("tiny teams: 1 to 4 people is +300% but not full growth points", () => {
  const s = scoreDeal(company({ headcount: 4, growth6m: 300, added6m: 3, growth3m: 300, added3m: 1, followers: 40, followers6m: 300 }), [], jobs(0), posts(0), spec, today);
  const pts = (k: string) => s.signals.find(x => x.key === k)!;
  assert.equal(pts("headcount6m").points, 9, "3 of 4 people needed for full points");
  assert.match(pts("headcount6m").reason, /Only 3 people added/);
  assert.equal(pts("headcount3m").points, 4);
  assert.ok(pts("followers6m").points > 0 && pts("followers6m").points < WEIGHTS.followers6m);
  // A team of 2 that added 1 person is not a sign of growth for timing.
  assert.equal(momentum(company({ growth6m: 100, added6m: 1 }), jobs(0), posts(0)).signs.length, 0);
});

test("edge of the window: the explanation says half, never full", () => {
  const t = timingOf(company({ lastRoundDate: "2025-11-01", growth6m: 38, added6m: 5 }), jobs(25), posts(0), "due", today);
  assert.equal(t.timing.label, "Nearly due and growing");
  assert.equal(t.points, WEIGHTS.timing / 2);
  assert.match(t.timing.explain, /Half timing points/);
  assert.doesNotMatch(t.timing.explain, /Full timing points/);
});

test("every signal carries a reason", () => {
  const s = scoreDeal(company({ growth6m: 20, growth3m: 10, followers6m: 5, lastRoundDate: "2025-03-01", lastRound: "seed", founded: 2024 }), [], jobs(2), posts(1), { ...spec, stages: ["seed"], founded: [2024, 9999], foundersFrom: ["x.com"], schools: ["MIT"] }, today);
  for (const sig of s.signals) assert.ok(sig.reason.length > 10, sig.key);
});

test("stage names", () => {
  assert.equal(stageName("pre_seed"), "Pre-seed");
  assert.equal(stageName("seed"), "Seed");
  assert.equal(stageName("series_a"), "Series A");
  assert.equal(stageName(undefined), "");
});

test("posts not checked because of rank count as none, so a checked company never ranks below an unchecked twin", () => {
  const c = company({ lastRound: "seed", lastRoundDate: "2025-03-10", growth6m: 20, added6m: 3 });
  const checked = scoreDeal(c, [], jobs(2), posts(0), spec, today).total;
  const unchecked = scoreDeal(c, [], jobs(2), { traction: null, raise: null, quotes: [], unchecked: "rank", skipped: "outside the top 50" }, spec, today);
  assert.equal(unchecked.total, checked);
  assert.match(unchecked.signals.find(s => s.key === "traction")!.reason, /Not checked: outside the top 50/);
  const off = scoreDeal(c, [], jobs(2), { traction: null, raise: null, quotes: [], unchecked: "off", skipped: "post search is not enabled" }, spec, today);
  assert.ok(!off.signals.some(s => s.key === "traction"), "not available for anyone: left out for everyone");
});

test("small changes never print as +0%, and the quiet explanation does not invent signs", () => {
  const s = scoreDeal(company({ growth6m: 0.3, added6m: 0, headcount: 10 }), [], jobs(0), posts(0), spec, today);
  assert.match(s.signals.find(x => x.key === "headcount6m")!.reason, /\+0\.3%/);
  const quiet = timingOf(company({ lastRoundDate: "2025-01-15", growth6m: -27, added6m: -3, headcount: 8 }), jobs(0), posts(0), "due", today);
  assert.doesNotMatch(quiet.timing.explain, /cancels one sign/);
  assert.match(quiet.timing.explain, /No recent growth/);
});

test("round 2: the due window depends on the stage of the last round", () => {
  assert.equal(timingOf(company({ lastRound: "pre_seed", lastRoundDate: "2026-02-01", growth6m: 40, added6m: 4 }), jobs(4), posts(0), "due", today).timing.label, "Due and growing", "8 months after a pre-seed");
  assert.equal(timingOf(company({ lastRound: "seed", lastRoundDate: "2026-02-01", growth6m: 40, added6m: 4 }), jobs(4), posts(0), "due", today).timing.label, "Raised recently", "8 months after a seed");
  assert.equal(timingOf(company({ lastRound: "series_a", lastRoundDate: "2025-01-01", growth6m: 40, added6m: 4 }), jobs(4), posts(0), "due", today).timing.label, "Due and growing", "21 months after a Series A");
  assert.match(timingOf(company({ lastRound: "series_a", lastRoundDate: "2026-02-01" }), jobs(0), posts(0), "due", today).timing.explain, /18 to 30 months later/);
});

test("round 2: missing data cannot lift a company above one with full data", () => {
  const thin = scoreDeal(company({ headcount: 3 }), [], jobs(0), posts(0), spec, today);
  const full = scoreDeal(company({ lastRound: "seed", lastRoundDate: "2025-03-10", headcount: 20, growth6m: 40, added6m: 6, growth3m: 25, added3m: 4, followers: 3000, followers6m: 25 }), [], jobs(6), posts(1), spec, today);
  assert.ok(full.total > thin.total, `${full.total} > ${thin.total}`);
  assert.ok(thin.scoredOn! < thin.applies!);
});

test("round 3: a thesis of companies with no disclosed round does not count timing as a point that applies", () => {
  const unfunded = scoreDeal(company({ headcount: 4, growth6m: 30, added6m: 1 }), [], jobs(1), posts(0), { timing: "due", unfunded: true }, today);
  const off = scoreDeal(company({ headcount: 4, growth6m: 30, added6m: 1 }), [], jobs(1), posts(0), { timing: "off", unfunded: true }, today);
  assert.equal(unfunded.total, off.total);
});

test("rounds with no usual next-round timing (grant, debt, convertible note) are not timed; series_unknown is timed as later", () => {
  for (const round of ["grant", "debt_financing", "convertible_note", "undisclosed", "post_ipo_equity"]) {
    const t = timingOf(company({ lastRound: round, lastRoundDate: "2025-03-10", growth6m: 40, added6m: 4 }), jobs(5), posts(0), "due", today);
    assert.equal(t.timing.label, "Timing not scored", round);
    assert.equal(t.points, undefined, round);
  }
  const later = timingOf(company({ lastRound: "series_unknown", lastRoundDate: "2024-10-01", growth6m: 40, added6m: 4 }), jobs(5), posts(0), "due", today);
  assert.equal(later.timing.label, "Due and growing");
  const untyped = timingOf(company({ lastRoundDate: "2025-03-10", growth6m: 40, added6m: 4 }), jobs(5), posts(0), "due", today);
  assert.equal(untyped.timing.label, "Due and growing");
});
