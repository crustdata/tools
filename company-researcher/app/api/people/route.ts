// GET /api/people?domain=stripe.com  ->  founders, executives, decision makers, who started in the last 90 days.
// Reads the same cached /company/enrich result as /api/company, so calling both costs one enrich.
import { companySection } from "@/lib/research";
import { authorize, fail, params } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let serverKey = false;
  try {
    const { domain, lite, apiKey: k } = params(req);
    serverKey = !k;
    const apiKey = await authorize(req, domain, k);
    const s = await companySection(domain, { lite, apiKey });
    return Response.json({ domain: s.domain, fetchedAt: s.fetchedAt, people: s.people, credits: s.credits });
  } catch (err) {
    return fail(err, serverKey);
  }
}
