// GET /api/config  ->  whether this deployment has a demo key, and which domains it covers. The page reads this to
// decide whether the API key box is optional or required.
import { serverKeyPolicy } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(serverKeyPolicy());
}
