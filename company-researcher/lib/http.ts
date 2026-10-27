// Shared helpers for the API routes: keys, the demo key policy, rate limits and error responses.
import { CrustdataError, MissingKeyError } from "./crustdata";
import { BudgetError, InputError, NotFoundError, parseQuery, resolve } from "./research";

// Visitors bring their own keys in headers (the web page sends them from the keys box; your own agents can set them
// too): x-crustdata-key for Crustdata, x-ai-key for Anthropic or OpenAI. Used for that request only, never stored or
// logged. A header that is present but empty is an error, so a blank key never silently falls back to the demo key.
function header(req: Request, name: string): string | undefined {
  const raw = req.headers.get(name);
  if (raw === null) return undefined;
  const k = raw.trim();
  if (!k) throw new InputError(`The ${name} header is empty.`);
  return k;
}
export const aiKey = (req: Request) => header(req, "x-ai-key");
export const userKey = (req: Request) => header(req, "x-crustdata-key");

// When the server has its own key, these settings decide what visitors may use it for:
//   ALLOW_SERVER_KEY=false    every visitor must bring a key
//   DEMO_DOMAINS=a.com,b.com  the server key only researches these companies
//   ALLOW_OPEN_DEMO=true      in production, let the server key research any company (still capped by DAILY_CREDIT_CAP)
// In production, with no DEMO_DOMAINS and no ALLOW_OPEN_DEMO, the demo covers the three example companies only.
const EXAMPLES = ["vercel.com", "clay.com", "retool.com"];
export function serverKeyPolicy() {
  const has = !!process.env.CRUSTDATA_API_KEY && process.env.ALLOW_SERVER_KEY !== "false";
  const listed = (process.env.DEMO_DOMAINS ?? "").split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
  const open = process.env.ALLOW_OPEN_DEMO === "true" || process.env.NODE_ENV !== "production";
  return { serverKey: has, demoDomains: listed.length ? listed : open ? null : EXAMPLES };
}

export class KeyRequiredError extends Error {}
export class RateLimitError extends Error {}

export function params(req: Request) {
  const url = new URL(req.url);
  const domain = (url.searchParams.get("domain") ?? url.searchParams.get("q") ?? "").trim();
  const liteParam = url.searchParams.get("lite");
  if (liteParam !== null && !["1", "0", "true", "false"].includes(liteParam)) throw new InputError("lite must be 1, 0, true or false.");
  const format = url.searchParams.get("format");
  if (format !== null && !["json", "md", "markdown"].includes(format.toLowerCase())) throw new InputError("format must be json or md.");
  return { url, domain, apiKey: userKey(req), format: format?.toLowerCase() ?? "json", lite: liteParam === null ? undefined : liteParam === "1" || liteParam === "true" };
}

// ---------- rate limits ----------
// A small in-memory sliding window per client IP. Requests that run on the visitor's own key are not limited.
const hits = new Map<string, number[]>();
/**
 * The visitor's address. Behind crustdata.com every request arrives from CloudFront, so Vercel sees an edge address;
 * the visitor's is in CloudFront-Viewer-Address ("ip:port"), trusted only when CloudFront's x-origin-secret header
 * matches ORIGIN_SECRET (anyone can send that header straight to the vercel.app host).
 */
export function clientIp(req: Request): string {
  const secret = process.env.ORIGIN_SECRET;
  if (secret && req.headers.get("x-origin-secret") === secret) {
    const viewer = req.headers.get("cloudfront-viewer-address");
    if (viewer) return viewer.replace(/^\[|\]?:\d+$/g, "");
  }
  return (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
}

export function rateLimit(req: Request, bucket: string, limit: number, windowMs: number) {
  const ip = clientIp(req);
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= limit) throw new RateLimitError("Too many requests. Wait a minute and try again, or use your own Crustdata API key.");
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
}

// Checks the input and decides which key may run it. Returns the visitor's key, or undefined for the server key.
export async function authorize(req: Request, input: string, apiKey?: string) {
  if (!input) throw new InputError("Add a company: ?domain=stripe.com, or a name like ?domain=Stripe");
  parseQuery(input);
  if (apiKey) return apiKey;
  const policy = serverKeyPolicy();
  if (!policy.serverKey) throw new KeyRequiredError("Add your Crustdata API key to run a research.");
  rateLimit(req, "research", Number(process.env.DEMO_RATE_LIMIT || 30), 10 * 60_000);
  if (policy.demoDomains) {
    const { domain } = await resolve(input); // identify is free
    if (!policy.demoDomains.includes(domain)) {
      throw new KeyRequiredError(`The free demo covers ${policy.demoDomains.join(", ")}. Add your own Crustdata API key to research any company.`);
    }
  }
  return undefined;
}

export function fail(err: unknown, usingServerKey = false): Response {
  const message = (err as Error)?.message ?? "Something went wrong";
  const out = (status: number, msg = message, needsKey = false) => Response.json({ error: msg, needsKey: needsKey || undefined }, { status });
  if (err instanceof InputError || err instanceof SyntaxError) return out(400, err instanceof SyntaxError ? "The request body is not valid JSON." : message);
  if (err instanceof NotFoundError) return out(404);
  if (err instanceof KeyRequiredError || err instanceof MissingKeyError) return out(401, message, true);
  if (err instanceof BudgetError) return out(402, message, true);
  if (err instanceof RateLimitError) return out(429);
  if (err instanceof CrustdataError) {
    if (err.status === 401) return out(401, "That Crustdata API key was not accepted. Check it and try again.", true);
    if (err.status === 402) return usingServerKey
      ? out(402, "The free demo is out of credits. Add your own Crustdata API key to keep going.", true)
      : out(402, "Your Crustdata key is out of credits. Top up at app.crustdata.com.", true);
    if (err.status === 403 || err.status === 429) return out(err.status);
    if (err.status >= 500 || err.status === 404) { console.error(message); return out(502, "Crustdata did not respond. Try again in a minute."); }
  }
  console.error(message);
  return out(500, "Something went wrong on our side. Try again in a minute.");
}
