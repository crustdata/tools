// A fake Crustdata for tests and `npm run replay`: answers from a fixture instead of the network, bills the
// same credits the real API would, and rejects malformed emails the way the real API does.

import { BASE_URL } from "./crustdata";

export type Fixture = {
  name?: string;
  csv?: string;
  columns?: string[];
  /** A subset of /account/endpoints, or absent for the defaults. */
  endpoints?: any[];
  credits?: number;
  responses: {
    identify?: Array<{ matched_on: string; match_type: string; matches: any[] }>;
    enrich?: Array<{ matched_on: string; match_type: string; matches: any[] }>;
    person?: Array<{ matched_on: string; match_type: string; match_status: string; matches: any[] }>;
    search?: { profiles: any[] };
  };
  /** Emails the fake API rejects as malformed (whole batch 400, like the real one). */
  invalidEmails?: string[];
  /** Field groups the fake key cannot read (400 "Invalid fields: x"). */
  disabledGroups?: string[];
};

export const DEFAULT_ENDPOINTS = [
  { path: "/company/identify", status: "enabled", effective_rate_limit_rpm: 30 },
  { path: "/company/enrich", status: "enabled", effective_rate_limit_rpm: 15, base_credits: 2, premium_fields: [{ field: "technographics", credits: 2 }] },
  { path: "/person/enrich", status: "enabled", effective_rate_limit_rpm: 15, base_credits: 1, premium_fields: [{ field: "contact.business_emails", credits: 1 }] },
  { path: "/person/search", status: "enabled", effective_rate_limit_rpm: 30, base_credits: 0.03 },
];

export type StubLog = Array<{ path: string; body: any; credits: number }>;

export function stubFetch(fx: Fixture, log: StubLog = []): typeof fetch {
  const endpoints = fx.endpoints ?? DEFAULT_ENDPOINTS;
  const price = (path: string) => endpoints.find(e => e.path === path) ?? {};
  const json = (body: unknown, credits = 0, status = 200) => {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-used": String(credits) } });
  };
  return async (input, init) => {
    const url = String(input);
    if (!url.startsWith(BASE_URL)) return new Response("not found", { status: 404 });
    const path = url.slice(BASE_URL.length).split("?")[0];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const entry = { path, body, credits: 0 };
    log.push(entry);
    if (path === "/account/credits") return json({ account: { credits: fx.credits ?? 1000 } });
    if (path === "/account/endpoints") return json({ endpoints });
    if (path === "/company/identify") {
      const asked: string[] = (body.domains ?? body.names ?? []).map((s: string) => s.toLowerCase());
      const out = asked.map(a => (fx.responses.identify ?? []).find(r => r.matched_on.toLowerCase() === a) ?? { matched_on: a, match_type: body.domains ? "domain" : "name", matches: [] });
      return json(out);
    }
    if (path === "/company/enrich") {
      const bad = (body.fields ?? []).filter((f: string) => fx.disabledGroups?.includes(f));
      if (bad.length) return json({ error: { type: "invalid_request", message: `Invalid fields: ${bad.join(", ")}` } }, 0, 400);
      const ids: number[] = body.crustdata_company_ids ?? [];
      const out = ids.map(id => (fx.responses.enrich ?? []).find(r => String(r.matched_on) === String(id)) ?? { matched_on: String(id), match_type: "crustdata_company_id", matches: [] });
      const p = price("/company/enrich");
      const matched = out.filter(r => r.matches.length);
      const tech = (body.fields ?? []).includes("technographics") ? matched.filter(r => r.matches[0]?.company_data?.technographics).length * (p.premium_fields?.[0]?.credits ?? 2) : 0;
      entry.credits = matched.length * (p.base_credits ?? 2) + tech;
      // The stub strips groups that were not asked for, like the real API.
      const trimmed = out.map(r => ({ ...r, matches: r.matches.map((m: any) => ({ ...m, company_data: pickGroups(m.company_data, body.fields ?? []) })) }));
      return json(trimmed, entry.credits);
    }
    if (path === "/person/enrich") {
      const emails: string[] | undefined = body.business_emails;
      const urls: string[] | undefined = body.professional_network_profile_urls;
      const bad = (emails ?? []).filter(e => fx.invalidEmails?.map(x => x.toLowerCase()).includes(e.toLowerCase()));
      if (bad.length) return json({ error: { type: "invalid_request", message: `Invalid business emails: ${bad.join(", ")}` } }, 0, 400);
      const badFields = (body.fields ?? []).filter((f: string) => fx.disabledGroups?.includes(f));
      if (badFields.length) return json({ error: { type: "invalid_request", message: `Invalid fields: ${badFields.join(", ")}` } }, 0, 400);
      const asked = (emails ?? urls ?? []).map(s => s.toLowerCase());
      const out = asked.map(a => (fx.responses.person ?? []).find(r => r.matched_on.toLowerCase() === a) ?? { matched_on: a, match_type: emails ? "business_email" : "professional_network_profile_url", match_status: "not_found", matches: [] });
      const p = price("/person/enrich");
      const matched = out.filter(r => r.match_status === "matched");
      const wantEmail = (body.fields ?? []).includes("contact.business_emails");
      const withEmail = wantEmail ? matched.filter(r => r.matches[0]?.person_data?.contact?.business_emails?.length).length : 0;
      entry.credits = matched.length * (p.base_credits ?? 1) + withEmail * (p.premium_fields?.[0]?.credits ?? 1);
      const trimmed = out.map(r => ({ ...r, matches: r.matches.map((m: any) => ({ ...m, person_data: pickGroups(m.person_data, body.fields ?? []) })) }));
      return json(trimmed, entry.credits);
    }
    if (path === "/person/search") {
      const profiles = fx.responses.search?.profiles ?? [];
      entry.credits = profiles.length * (price("/person/search").base_credits ?? 0.03);
      return json({ profiles, total_count: profiles.length }, entry.credits);
    }
    return json({ error: { message: `No stub for ${path}` } }, 0, 404);
  };
}

/** Keeps the top-level groups asked for (plus ids). "contact.business_emails" keeps contact.business_emails only. */
function pickGroups(record: any, fields: string[]): any {
  if (!record || !fields.length) return record;
  const out: any = {};
  for (const k of Object.keys(record)) {
    if (k.startsWith("crustdata_") || fields.includes(k)) { out[k] = record[k]; continue; }
    const sub = fields.filter(f => f.startsWith(`${k}.`)).map(f => f.slice(k.length + 1));
    if (sub.length && record[k] && typeof record[k] === "object") out[k] = Object.fromEntries(sub.filter(s => s in record[k]).map(s => [s, record[k][s]]));
  }
  return out;
}
