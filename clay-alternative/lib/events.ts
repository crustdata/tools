// The events a run emits. The API route streams them as NDJSON lines, the page renders them, the CLI prints them,
// and `npm run replay` plays a saved list of them. One shape everywhere.

import type { Cell, CostSummary, Estimate, RowStatus } from "./types";

export type Summary = {
  rows: number; matched: number; partial: number; unresolved: number;
  people: { matched: number; not_found: number; redacted: number; invalid: number; ambiguous: number };
  companies: { matched: number; not_found: number; ambiguous: number };
};

export type RunEvent =
  | { type: "start"; rows: number; columns: string[]; estimate: Estimate; warnings: string[]; problems: Array<{ line: number; reason: string }>; pricing: "shown" | "hidden" }
  | { type: "cells"; row: number; cells: Record<string, Cell>; status?: RowStatus }
  | { type: "progress"; phase: "people" | "companies"; done: number; total: number }
  | { type: "cost"; cost: CostSummary }
  | { type: "note"; message: string }
  | { type: "done"; cost: CostSummary; remaining: number | null; summary: Summary; elapsedMs: number }
  | { type: "error"; message: string; fatal: boolean };

export const encodeEvent = (e: RunEvent): string => JSON.stringify(e) + "\n";

/** Reads NDJSON lines out of a stream of text chunks. Keeps a partial trailing line for the next chunk. */
export function ndjsonReader(onEvent: (e: RunEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    },
    end() { const line = buffer.trim(); buffer = ""; if (line) onEvent(JSON.parse(line)); },
  };
}
