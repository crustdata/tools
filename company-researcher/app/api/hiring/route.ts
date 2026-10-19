// GET /api/hiring?domain=stripe.com  ->  postings in the last 90 days, by role type, newest 15 (/job/search x3)
import { hiringSection } from "@/lib/research";
import { authorize, fail, params } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let serverKey = false;
  try {
    const { domain, apiKey: k } = params(req);
    serverKey = !k;
    const apiKey = await authorize(req, domain, k);
    return Response.json(await hiringSection(domain, { apiKey }));
  } catch (err) {
    return fail(err, serverKey);
  }
}
