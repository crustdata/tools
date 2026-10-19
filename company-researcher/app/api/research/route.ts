// GET /api/research?domain=stripe.com              the full structured result as JSON (see lib/types.ts)
// GET /api/research?domain=stripe.com&format=md    the same brief as markdown
// Add &lite=1 to skip the tech stack and recent posts add-ons (2.45 credits instead of 9.45).
// domain also accepts a company name (?domain=Stripe). Optional headers: x-crustdata-key, x-ai-key.
import { research } from "@/lib/research";
import { toMarkdown } from "@/lib/markdown";
import { aiKey, authorize, fail, params } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  let serverKey = false;
  try {
    const { domain, lite, apiKey: k, format } = params(req);
    serverKey = !k;
    const apiKey = await authorize(req, domain, k);
    const r = await research(domain, { lite, apiKey, aiKey: aiKey(req) });
    if (format === "md" || format === "markdown") {
      return new Response(toMarkdown(r), { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    return Response.json(r);
  } catch (err) {
    return fail(err, serverKey);
  }
}
