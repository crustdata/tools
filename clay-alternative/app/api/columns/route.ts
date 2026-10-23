// GET /api/columns  ->  the catalogue, with the cost per row at the caller's prices (list prices without a key).
import { LIST_PRICES } from "@/lib/account";
import { COLUMNS, DEFAULT_COLUMNS, costOf, endpointFor } from "@/lib/columns";
import { accountFor, fail, policy, pricingFor, rateLimit, userKey } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const own = userKey(req);
    const key = own ?? (policy().serverKey ? process.env.CRUSTDATA_API_KEY : undefined);
    let prices = LIST_PRICES, emailColumn = true;
    if (key) {
      rateLimit(req, "columns", 30, 60_000);
      const a = await accountFor(key);
      prices = a.prices; emailColumn = a.emailColumn;
    }
    const pricing = pricingFor(!!own);
    return Response.json({
      pricing,
      defaults: DEFAULT_COLUMNS,
      columns: COLUMNS.map(c => ({
        id: c.id, label: c.label, group: c.group, note: c.note, path: c.path, endpoint: endpointFor(c), source: c.source.kind,
        cost: pricing === "shown" ? costOf(c, prices, emailColumn) : { each: null, per: costOf(c, prices, emailColumn).per, text: c.source.kind === "identify" ? "Free" : c.source.kind === "person_premium" && !emailColumn ? "Needs contact access" : "Paid" },
        available: !(c.source.kind === "person_premium" && !emailColumn),
      })),
    });
  } catch (err) {
    return fail(err);
  }
}
