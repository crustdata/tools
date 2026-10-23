// POST /api/enrich  ->  NDJSON events, one per line, as the table fills in.
//
//   body: { headers: [...], rows: [{ line, cells }], columns: ["person.title", ...], dryRun?: true }
//   header: x-crustdata-key (optional; otherwise the deployment's key)
//   events: start (estimate), cells (one row's new cells), progress, cost, note, error, done
//
// Rows are read on the server from their cells (identifiers normalised again), so the page can never make the server
// call something it did not parse itself. A dry run returns the estimate only: the cost before any paid call.
import { resolveColumns } from "@/lib/columns";
import { createClient } from "@/lib/crustdata";
import { readRecords } from "@/lib/csv";
import { encodeEvent, type RunEvent } from "@/lib/events";
import { accountFor, cacheFor, checkDailyCap, fail, InputError, policy, pricingFor, rateLimit, readJson, recordSpend, resolveKey } from "@/lib/http";
import { plan } from "@/lib/plan";
import { runPlan } from "@/lib/run";
import type { Estimate } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY = 8 * 1024 * 1024;

const hiddenEstimate = (e: Estimate): Estimate => ({ ...e, credits: -1, listCredits: -1, lines: [], listLines: [] });

export async function POST(req: Request) {
  try {
    const { key, own } = resolveKey(req);
    const p = policy();
    if (!own) rateLimit(req, "enrich", 30, 10 * 60_000);
    const body: any = await readJson(req, MAX_BODY);
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.rows) || !Array.isArray(body.columns)) throw new InputError("Send { headers: [...], rows: [{ line, cells }], columns: [ids] }.");
    if (!body.rows.length) throw new InputError("No rows to enrich.");
    const headers: string[] = Array.isArray(body.headers) && body.headers.length ? body.headers.map((h: unknown) => String(h ?? "")) : [...new Set(body.rows.flatMap((r: any) => (r && typeof r === "object" && r.cells && typeof r.cells === "object" ? Object.keys(r.cells) : [])))] as string[];
    if (!headers.length) throw new InputError("Every row needs a cells object with at least one column.");
    const limit = Math.min(body.rows.length, p.maxRows);
    const records = body.rows.slice(0, limit).map((r: any, i: number) => {
      if (!r || typeof r !== "object" || Array.isArray(r) || !r.cells || typeof r.cells !== "object") throw new InputError(`rows[${i}] must be { line, cells }.`);
      const values = headers.map(h => { const v = (r.cells as Record<string, unknown>)[h]; if (v === undefined || v === null) return ""; if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v); throw new InputError(`rows[${i}].cells["${h}"] must be text.`); });
      const line = Number.isInteger(r.line) && r.line > 0 ? r.line : i + 2;
      return { line, values };
    });
    const detected = readRecords(headers, records);
    const { columns, unknown } = resolveColumns(body.columns.map((c: unknown) => String(c)));
    if (unknown.length) throw new InputError(`Unknown columns: ${unknown.map(u => `${u.id} (closest: ${u.closest.join(", ")})`).join("; ")}`);
    if (!columns.length) throw new InputError("Pick at least one column.");

    const account = await accountFor(key, { probeEmail: detected.rows.some(r => r.id?.kind === "email") });
    const thePlan = plan(detected.rows, columns, account);
    if (body.rows.length > limit) thePlan.warnings.unshift(`Only the first ${limit} rows run here (MAX_ROWS_PER_RUN). For the whole file, use the CLI: npm run enrich -- your-file.csv`);
    const pricing = pricingFor(own);
    if (!own) checkDailyCap(thePlan.estimate.credits);
    if (body.dryRun) {
      return Response.json({ estimate: pricing === "shown" ? thePlan.estimate : hiddenEstimate(thePlan.estimate), warnings: thePlan.warnings, problems: thePlan.problems, pricing, rows: detected.rows.length, remaining: pricing === "shown" ? account.credits : null });
    }

    const client = createClient({ apiKey: key, signal: req.signal, rpm: account.rpm, onCredits: own ? undefined : (_path, c) => recordSpend(c) });
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (e: RunEvent) => { if (closed) return; try { controller.enqueue(enc.encode(encodeEvent(e))); } catch { closed = true; } };
        const emit = (e: RunEvent) => {
          if (pricing === "hidden") {
            // Rows and companies only: the credit figures stay on the server.
            if (e.type === "cost") return send({ ...e, cost: { ...e.cost, credits: -1, byEndpoint: {}, cached: -1 } });
            if (e.type === "done") return send({ ...e, cost: { ...e.cost, credits: -1, byEndpoint: {}, cached: -1 }, remaining: null });
            if (e.type === "start") return send({ ...e, estimate: hiddenEstimate(e.estimate) });
          }
          send(e);
        };
        try {
          await runPlan(thePlan, { client, cache: cacheFor(key), account, emit, pricing, maxCredits: p.maxCreditsPerRun, readRemaining: pricing === "shown", signal: req.signal });
        } catch {
          // The error event was already emitted by the runner, or the client went away.
        } finally {
          if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } }
        }
      },
      cancel() { closed = true; },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  } catch (err) {
    return fail(err);
  }
}
