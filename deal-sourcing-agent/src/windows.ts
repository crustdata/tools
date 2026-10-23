/** The "due to raise" windows, used by the scorer (src/score.ts) and by the thesis summary printed before a run. */

/**
 * When the next round usually comes, in months after the last one: full points inside `full`, half points between
 * `half[0]` and `full[0]` and between `full[1]` and `half[1]`. Change the numbers here.
 */
export const DUE_WINDOWS = {
  early: { name: "a pre-seed or angel round", full: [6, 15], half: [4, 21] },
  seed: { name: "a seed round", full: [12, 24], half: [9, 30] },
  later: { name: "a Series A or later", full: [18, 30], half: [12, 36] },
} as const;
/**
 * The window after this round, or undefined for rounds with no usual next-round timing (grant, debt, convertible
 * note, crowdfunding, private equity, post-IPO, undisclosed and the like): those are not timed. A round date with no
 * type on record is timed as a seed round.
 */
export function dueWindow(round?: string): (typeof DUE_WINDOWS)[keyof typeof DUE_WINDOWS] | undefined {
  if (round === "pre_seed" || round === "angel") return DUE_WINDOWS.early;
  if (round === "seed" || !round) return DUE_WINDOWS.seed; // a date with no round type on record: timed as a seed
  if (round && /^series_(?:[a-j]|unknown)$/.test(round)) return DUE_WINDOWS.later;
  return undefined;
}


/** "6 to 15 months after a pre-seed or angel round, 12 to 24 after a seed": the windows for these stages, in words. */
export function windowsText(stages?: string[]): string {
  const ws = [...new Set((stages?.length ? stages : ["pre_seed", "seed", "series_a"]).map(dueWindow).filter(w => w !== undefined))];
  if (!ws.length) return "these rounds have no usual next-round timing, so timing is not scored";
  return ws.map((w, i) => `${w.full[0]} to ${w.full[1]}${i === 0 ? " months" : ""} after ${w.name}`).join(", ");
}
