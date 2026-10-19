// GET /api/check with an x-crustdata-key header  ->  is the key valid, and which sections can it read. Free.
import { enrichEntitlements, withApiKey } from "@/lib/crustdata";
import { fail, rateLimit, userKey } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const key = userKey(req);
    if (!key) return Response.json({ error: "Send your key in the x-crustdata-key header." }, { status: 400 });
    rateLimit(req, "check", 10, 60_000);
    const e = await withApiKey(key, () => enrichEntitlements());
    const missing = e.groups.filter(g => !g.enabled).map(g => g.group);
    return Response.json({ ok: true, missing });
  } catch (err) {
    return fail(err);
  }
}
