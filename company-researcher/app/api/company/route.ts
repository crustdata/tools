// GET /api/company?domain=stripe.com  ->  company profile and leadership (one /company/enrich call).
// domain also accepts a company name (?domain=Stripe).
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
    return Response.json(await companySection(domain, { lite, apiKey }));
  } catch (err) {
    return fail(err, serverKey);
  }
}
