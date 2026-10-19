// The written brief.
//   GET  /api/brief?domain=stripe.com          runs the research, returns only the brief
//   POST /api/brief { company, people, hiring } writes the brief from sections you already have (no Crustdata call).
//        The web UI uses this, so a research costs one enrich however the routes are hosted.
import { research, writeBrief } from "@/lib/research";
import { InputError } from "@/lib/research";
import { aiKey, authorize, fail, params, rateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let serverKey = false;
  try {
    const { domain, lite, apiKey: k } = params(req);
    serverKey = !k;
    const apiKey = await authorize(req, domain, k);
    const r = await research(domain, { lite, apiKey, aiKey: aiKey(req) });
    return Response.json({ domain: r.domain, brief: r.brief, errors: r.errors, credits: r.credits });
  } catch (err) {
    return fail(err, serverKey);
  }
}

// The body must carry the sections in the shape /api/company and /api/hiring return.
function validate(body: any) {
  const c = body?.company, p = body?.people;
  const missing: string[] = [];
  if (!c || typeof c !== "object") missing.push("company");
  else {
    if (typeof c.name !== "string") missing.push("company.name");
    if (typeof c.domain !== "string") missing.push("company.domain");
    for (const k of ["news", "posts", "categories"]) if (!Array.isArray(c[k])) missing.push(`company.${k}`);
  }
  if (!p || typeof p !== "object") missing.push("people");
  else for (const k of ["founders", "executives", "decisionMakers", "recentJoins"]) if (!Array.isArray(p[k])) missing.push(`people.${k}`);
  if (body?.hiring !== undefined && body.hiring !== null && typeof body.hiring !== "object") missing.push("hiring");
  if (missing.length) throw new InputError(`Send { company, people, hiring } as returned by /api/company and /api/hiring. Missing or wrong: ${missing.join(", ")}.`);
}

export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (text.length > 1_000_000) return Response.json({ error: "Body too large" }, { status: 413 });
    const body = JSON.parse(text);
    validate(body);
    const key = aiKey(req);
    if (key) rateLimit(req, "ai-brief", 20, 10 * 60_000);
    return Response.json({ brief: await writeBrief({ company: body.company, people: body.people, hiring: body.hiring ?? null }, key) });
  } catch (err) {
    return fail(err);
  }
}
