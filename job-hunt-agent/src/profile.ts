/**
 * Your search, in profile.json (written by `npm run setup`, plain JSON you can edit). Command line flags override
 * it for one run. Every field is optional except a title; the defaults are below.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ROOT } from "./config.js";
import { canonicalSkill } from "./skills.js";

export type Profile = {
  /** Path to your CV (.md, .txt or .pdf), relative to this folder. */
  cv: string;
  /** Job titles to search, for example ["software engineer", "backend engineer"]. Words match in any order. */
  titles: string[];
  /** A city or area; jobs within radiusMiles of it. Empty with remote "only". */
  location: string;
  radiusMiles: number;
  /** "no": near the location only. "also": near it, or remote in the country. "only": remote in the country. */
  remote: "no" | "also" | "only";
  country: string;
  /** Schools for the alumni search. Empty: the ones read from your CV. */
  schools: string[];
  /** Years of work experience. Null: read from the dates in your CV. */
  yearsExperience: number | null;
  /** Skills you have that the CV does not spell out. Added to the ones read from the CV. */
  skills: string[];
  /** Companies to leave out, by name or website. */
  skipCompanies: string[];
  /** Words that leave a job out when its title has them, for example ["intern", "principal"]. */
  skipTitleWords: string[];
  /** True if you need a visa sponsor: postings that say they do not sponsor lose 25 points. */
  needsSponsorship: boolean;
  /** Only jobs posted in the last N days. */
  days: number;
  /** How many of the newest matching jobs to read and score (0.03 credits each). */
  scan: number;
  /** How many of the best to look up people for (about 3 credits each at list price). */
  top: number;
  /** Keep jobs posted by staffing agencies (left out by default). */
  includeAgencies: boolean;
};

export const DEFAULTS: Profile = {
  cv: "cv.md", titles: [], location: "", radiusMiles: 50, remote: "no", country: "United States", schools: [],
  yearsExperience: null, skills: [], skipCompanies: [], skipTitleWords: [], needsSponsorship: false, days: 30,
  scan: 50, top: 5, includeAgencies: false,
};

/** A list from JSON. A string is split on commas, except schools, whose names have commas: those split on ";". */
const list = (v: unknown, sep: string | RegExp = ","): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(sep) : []).map(x => String(x).trim()).filter(Boolean);

/** Reads profile.json. A missing file is an empty profile; a broken one is an error with the line to fix. */
export function readProfileFile(path: string): Partial<Profile> {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return {}; }
  try {
    const j = JSON.parse(text.replace(/^﻿/, ""));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}). Fix it, or delete it and run npm run setup.`);
  }
}

/** Defaults, then profile.json, then flags. Throws with a plain sentence when something cannot work. */
export function resolveProfile(file: Partial<Profile>, flags: Partial<Profile>, mode: "hunt" | "job" = "hunt"): Profile {
  const p = { ...DEFAULTS, ...clean(file), ...clean(flags) };
  // One job needs no search: the posting gives the title and the place.
  if (mode === "hunt" && !p.titles.length) throw new Error('No job title to search. Pass --title "software engineer", or run npm run setup.');
  if (mode === "hunt" && p.remote !== "only" && !p.location) throw new Error('No location. Pass --location "San Francisco", or --remote for remote jobs only.');
  if (!["no", "also", "only"].includes(p.remote)) throw new Error('remote must be "no", "also" or "only".');
  const ranges: Array<[keyof Profile, number, number]> = [["radiusMiles", 1, 300], ["days", 1, 90], ["scan", 1, 500], ["top", 1, 50]];
  for (const [k, lo, hi] of ranges) {
    const v = p[k] as number;
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k} must be a whole number from ${lo} to ${hi} (got ${String(p[k])}).`);
  }
  if (p.top > p.scan) p.top = p.scan;
  if (p.yearsExperience !== null && (!Number.isFinite(p.yearsExperience) || p.yearsExperience < 0 || p.yearsExperience > 60)) throw new Error("yearsExperience must be a number from 0 to 60.");
  return p;
}

/** Drops unknown keys and empty values, and normalises lists and numbers. */
function clean(x: Partial<Profile>): Partial<Profile> {
  const out: Partial<Profile> = {};
  const src = x as Record<string, unknown>;
  for (const key of Object.keys(DEFAULTS) as Array<keyof Profile>) {
    const v = src[key];
    if (v === undefined || v === null || v === "") continue;
    const d = DEFAULTS[key];
    if (Array.isArray(d)) {
      const l = list(v, key === "schools" ? ";" : ",");
      if (l.length) (out as Record<string, unknown>)[key] = key === "skills" ? l.map(canonicalSkill) : l;
    } else if (typeof d === "number" || key === "yearsExperience") (out as Record<string, unknown>)[key] = Number(v);
    else if (typeof d === "boolean") (out as Record<string, unknown>)[key] = v === true || v === "true";
    else (out as Record<string, unknown>)[key] = String(v).trim();
  }
  return out;
}

export const cvPath = (p: Profile): string => (isAbsolute(p.cv) ? p.cv : resolve(ROOT, p.cv));
