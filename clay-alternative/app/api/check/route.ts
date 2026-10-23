// GET /api/check  ->  what this page can do: whether a deployment key exists, whether credits are shown, the caps,
// and (free, memoised per key) the key's credits, prices and email access. With an x-crustdata-key header it checks
// that key instead.
import { accountFor, fail, policy, pricingFor, rateLimit, userKey } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const p = policy();
    const own = userKey(req);
    const base = { serverKey: p.serverKey, maxRows: p.maxRows, pricing: pricingFor(!!own) };
    const key = own ?? (p.serverKey ? process.env.CRUSTDATA_API_KEY! : undefined);
    if (!key) return Response.json({ ...base, ok: false, needsKey: true });
    rateLimit(req, "check", 30, 60_000);
    const a = await accountFor(key, { probeEmail: true });
    return Response.json({
      ...base, ok: true, own: !!own,
      credits: base.pricing === "shown" ? a.credits : null,
      prices: base.pricing === "shown" ? a.prices : null,
      listPrices: a.listPrices,
      emailColumn: a.emailColumn,
      emailLookup: a.emailLookup,
    });
  } catch (err) {
    return fail(err);
  }
}
