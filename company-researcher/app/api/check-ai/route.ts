// GET /api/check-ai with an x-ai-key header  ->  is the Anthropic or OpenAI key valid, and which model will write the
// brief. Uses the provider's free model list; no tokens are spent.
import { AiKeyError, pickModel } from "@/lib/ai";
import { aiKey, fail, rateLimit } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let key: string | undefined;
  try {
    key = aiKey(req);
    if (!key) return Response.json({ error: "Send your AI key in the x-ai-key header." }, { status: 400 });
    rateLimit(req, "check", 10, 60_000);
  } catch (err) {
    return fail(err);
  }
  try {
    const { provider, model } = await pickModel(key);
    return Response.json({ ok: true, provider, model });
  } catch (err) {
    const message = err instanceof AiKeyError ? err.message : "Could not reach the AI provider. Try again in a minute.";
    return Response.json({ error: message }, { status: err instanceof AiKeyError ? 401 : 502 });
  }
}
