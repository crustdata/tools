/**
 * Alert thresholds, from `config/thresholds.json`. Every headcount and hiring rule needs a percentage AND a count, so a
 * six-person company losing one person (17%) does not fire, while a 200-person company losing 20 does.
 */

import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.js";

export type Thresholds = {
  /** Down by `percent` AND `people`, or by `or_people` whatever the percentage (large companies). */
  headcount_down: { percent: number; people: number; or_people: number };
  /** Companies under `below` people use these instead (a 5-person company losing 2 is news). */
  small_company: { below: number; percent: number; people: number };
  team_down: { percent: number; people: number; min_team: number };
  headcount_up: { percent: number; people: number };
  hiring_stopped: { from_at_least: number };
  hiring_jump: { times: number; more_roles: number };
  hiring_slowed: { percent: number; fewer_roles: number };
  hiring_started: { quiet_weeks: number; to_at_least: number };
  /** Headcount is compared with its highest (or lowest) reading in this many days, since the last headcount alert. */
  reference_days: number;
  /** A hiring jump, slowdown or restart is not repeated for a company within this many days (a stop is never held back). */
  repeat_after_days: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  headcount_down: { percent: 10, people: 3, or_people: 25 },
  small_company: { below: 15, percent: 25, people: 2 },
  team_down: { percent: 20, people: 3, min_team: 5 },
  headcount_up: { percent: 25, people: 5 },
  hiring_stopped: { from_at_least: 3 },
  hiring_jump: { times: 2, more_roles: 5 },
  hiring_slowed: { percent: 50, fewer_roles: 5 },
  hiring_started: { quiet_weeks: 4, to_at_least: 3 },
  reference_days: 180,
  repeat_after_days: 28,
};

/** Counts and multipliers must be at least 1; percentages above 0. */
const AT_LEAST_ONE = new Set(["people", "or_people", "min_team", "from_at_least", "times", "more_roles", "fewer_roles", "quiet_weeks", "to_at_least", "below"]);

/** Reads the file and fills anything missing from the defaults. Throws a plain message on a bad value. */
export function loadThresholds(file = config.thresholdsFile): Thresholds {
  if (!existsSync(file)) return DEFAULT_THRESHOLDS;
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (err) { throw new Error(`${file} is not valid JSON: ${(err as Error).message}`); }
  return mergeThresholds(raw, file);
}

export function mergeThresholds(raw: any, file = "thresholds.json"): Thresholds {
  const out: any = structuredClone(DEFAULT_THRESHOLDS);
  if (!raw || typeof raw !== "object") throw new Error(`${file} must be a JSON object.`);
  for (const key of Object.keys(raw)) if (!(key in DEFAULT_THRESHOLDS) && !key.startsWith("_")) throw new Error(`${file}: unknown setting "${key}". Known: ${Object.keys(DEFAULT_THRESHOLDS).join(", ")}.`);
  for (const [key, def] of Object.entries(DEFAULT_THRESHOLDS)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof def === "number") {
      if (typeof v !== "number" || !(v > 0)) throw new Error(`${file}: "${key}" must be a positive number.`);
      out[key] = v;
      continue;
    }
    if (!v || typeof v !== "object") throw new Error(`${file}: "${key}" must be an object like ${JSON.stringify(def)}.`);
    for (const sub of Object.keys(v)) if (!(sub in def) && !sub.startsWith("_")) throw new Error(`${file}: unknown setting "${key}.${sub}". Known: ${Object.keys(def).join(", ")}.`);
    for (const sub of Object.keys(def)) {
      if (v[sub] === undefined) continue;
      const min = AT_LEAST_ONE.has(sub) ? 1 : 0;
      if (typeof v[sub] !== "number" || !(v[sub] > 0) || v[sub] < min) throw new Error(`${file}: "${key}.${sub}" must be a number${min ? ", 1 or more" : " above 0"}.`);
      if (sub === "percent" && key !== "headcount_up" && v[sub] > 100) throw new Error(`${file}: "${key}.percent" must be 100 or less.`);
      out[key][sub] = v[sub];
    }
  }
  return out;
}
