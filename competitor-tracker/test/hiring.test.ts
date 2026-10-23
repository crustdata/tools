import assert from "node:assert/strict";
import { test } from "node:test";
import { functionLabel, hiringItems, matchPlace, recentJobs, weeklyAverage, type HiringInput, type JobRecord } from "../src/hiring.js";

const job = (id: number, title: string, category: string, city: string, country: string, date = "2026-10-22T10:00:00"): JobRecord => ({
  crustdata_job_id: id,
  job_details: { title, category, url: `https://jobs.example/${id}` },
  location: { city, country, raw: `${city}, ${country}` },
  metadata: { date_added: date },
});
const history = [
  { domain: "a", week: "2026-W42", newJobs: 2, recentJobs: 31 },
  { domain: "a", week: "2026-W41", newJobs: 3, recentJobs: 30 },
  { domain: "a", week: "2026-W40", newJobs: 4, recentJobs: 29 },
];
const input = (over: Partial<HiringInput>): HiringInput => ({ newJobs: [], places: [], history, currentWeek: "2026-W43", weeks: 1, recentNow: null, recentBefore: null, ...over });

test("functionLabel turns categories into plain words", () => {
  assert.equal(functionLabel("Sales"), "sales");
  assert.equal(functionLabel("Others"), "other");
  assert.equal(functionLabel(null), "other");
});

test("matchPlace matches whole words, with common short forms", () => {
  assert.equal(matchPlace(job(1, "AE", "Sales", "London", "United Kingdom"), ["london", "Berlin"]), "london");
  assert.equal(matchPlace(job(1, "AE", "Sales", "Austin", "United States"), ["United States"]), "United States");
  assert.equal(matchPlace(job(1, "AE", "Sales", "Austin", "United States"), ["Paris"]), undefined);
  assert.equal(matchPlace(job(1, "AE", "Sales", "Indianapolis", "United States"), ["India"]), undefined, "India is not Indianapolis");
  assert.equal(matchPlace(job(1, "AE", "Sales", "London", "United Kingdom"), ["UK"]), "UK");
  assert.equal(matchPlace(job(1, "AE", "Sales", "New York", "United States"), ["NYC"]), "NYC");
});

test("recentJobs keeps postings from the last 30 days (and undated ones)", () => {
  const now = new Date("2026-10-26T08:00:00Z");
  const jobs = [job(1, "a", "Sales", "x", "y", "2026-10-20T00:00:00"), job(2, "b", "Sales", "x", "y", "2026-08-01T00:00:00"), { crustdata_job_id: 3 }];
  assert.deepEqual(recentJobs(jobs, now).map(j => j.crustdata_job_id), [1, 3]);
});

test("weeklyAverage needs two past weeks and ignores the current one", () => {
  assert.equal(weeklyAverage(history, "2026-W43"), 3);
  assert.equal(weeklyAverage(history.slice(0, 1), "2026-W43"), null);
  assert.equal(weeklyAverage([...history, { domain: "a", week: "2026-W43", newJobs: 50, recentJobs: 60 }], "2026-W43"), 3);
});

test("hiringItems: change by function and place, the rate first, posting dates, senior roles, deduped", () => {
  const jobs = [
    ...Array.from({ length: 10 }, (_, i) => job(100 + i, i ? "Account Executive" : "Head of Sales, EMEA", "Sales", "London", "United Kingdom", `2026-10-2${i % 3}T10:00:00`)),
    ...Array.from({ length: 4 }, (_, i) => job(200 + i, "SDR", "Sales", "New York", "United States")),
    job(300, "Backend Engineer", "Engineering", "Berlin", "Germany"),
    job(300, "Backend Engineer", "Engineering", "Berlin", "Germany"),
  ];
  const items = hiringItems(input({ newJobs: jobs, places: ["London", "New York"] }));
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "15 new postings, up from about 3 a week: 14 sales roles (10 in London, 4 in New York) and 1 engineering role, posted Oct 20 to Oct 22");
  assert.equal(items[0].why, "a hiring push");
  assert.equal(items[0].linkLabel, "one of them");
  assert.equal(items[0].date, undefined, "a count over the week has no single date");
  assert.match(items[1].text, /Senior roles opened: Head of Sales, EMEA/);
});

test("hiringItems: a normal week, a skipped week, and a slowdown in recent listings", () => {
  assert.deepEqual(hiringItems(input({ recentNow: 31, recentBefore: 31 })), []);
  assert.equal(hiringItems(input({ newJobs: [job(1, "AE", "Sales", "London", "UK")] }))[0].text, "1 new posting: 1 sales role, posted Oct 22");
  const twoWeeks = Array.from({ length: 8 }, (_, i) => job(i, "AE", "Sales", "x", "y"));
  assert.equal(hiringItems(input({ newJobs: twoWeeks, weeks: 2 }))[0].text, "8 new postings over 2 weeks: 8 sales roles, posted Oct 22", "4 a week over 2 weeks is not a push");
  const slower = hiringItems(input({ recentNow: 18, recentBefore: 31 }));
  assert.equal(slower.length, 1);
  assert.equal(slower[0].text, "Fewer new listings: 18 posted in the last 30 days, down from 31 at the last digest");
  assert.deepEqual(hiringItems(input({ recentNow: 29, recentBefore: 31 })), [], "a small dip is not news");
});
