// Shared types. lib/ has no Next.js imports, so the CLI, the tests and the API routes all use the same code.

export type IdKind = "profile_url" | "email" | "domain" | "company_name";

/** One identifier read from a row, already normalised. */
export type Identifier = { kind: IdKind; value: string; personal?: boolean };

/** One CSV row as the planner sees it: the original cells, the real line number in the file, and what identifies it. */
export type InputRow = {
  line: number;
  cells: Record<string, string>;
  id?: Identifier;
  /** A second identifier for the company, when the row has both a work email and a website column. */
  companyId?: Identifier;
  /** Why the row cannot be enriched (no identifier, malformed email, ...). */
  problem?: string;
  /** The row names a person (a name column is filled) but carries no email or profile URL. */
  personNameOnly?: boolean;
};

export type CellStatus =
  | "matched" | "not_found" | "ambiguous" | "redacted" | "personal_email" | "needs_access" | "no_identifier" | "invalid" | "error";

/** One filled cell. `source` names the Crustdata endpoint and field path it was read from. */
export type Cell = { value: string | number | null; status: CellStatus; source?: string; note?: string; confidence?: number; /** When the record was fetched from Crustdata (ISO date). */ at?: string };

export type ColumnGroup = "Person" | "Company";

/** Where a column's value comes from: the free identify call, a company enrich group, a person enrich group, or a premium field. */
export type ColumnSource =
  | { kind: "identify" }
  | { kind: "company_enrich"; group: string }
  | { kind: "company_premium"; group: "technographics" }
  | { kind: "person_enrich"; group: string }
  | { kind: "person_premium"; field: "contact.business_emails" };

export type Column = {
  id: string;
  label: string;
  group: ColumnGroup;
  source: ColumnSource;
  /** The field path shown on hover and written to docs. */
  path: string;
  /** Reads the value out of a matched record. Returns null when the record has no value. */
  pick: (record: any, ctx: PickContext) => string | number | null;
  /** One line for the picker and the README. */
  note: string;
};

export type PickContext = { domain?: string };

export type Prices = {
  companyEnrich: number;
  technographics: number;
  personEnrich: number;
  businessEmail: number;
  personSearch: number;
};

export type Account = {
  /** Credits remaining, or null when the key could not be checked. */
  credits: number | null;
  prices: Prices;
  listPrices: Prices;
  /** Requests per minute per endpoint path, from /account/endpoints. */
  rpm: Record<string, number>;
  /** Whether contact.business_emails is a premium field on /person/enrich for this key. */
  emailColumn: boolean;
  /** Whether /person/enrich accepts business_emails as an identifier for this key. "unknown" until probed. */
  emailLookup: boolean | "unknown";
};

export type EstimateLine = { label: string; count: number; each: number; credits: number };

export type Estimate = {
  rows: number;
  usable: number;
  people: number;
  companies: number;
  /** Companies that will be found through the people's current employers (profile URL and personal email rows). */
  companiesFromPeople: number;
  credits: number;
  listCredits: number;
  lines: EstimateLine[];
  /** The same lines at list prices. */
  listLines: EstimateLine[];
  /** What the estimate cannot know yet, in one sentence, or empty. */
  note: string;
};

export type Plan = {
  columns: Column[];
  rows: InputRow[];
  people: { urls: string[]; emails: string[] };
  companies: { domains: string[]; names: string[] };
  personFields: string[];
  companyFields: string[];
  needsPersonEnrich: boolean;
  needsCompanyEnrich: boolean;
  needsIdentify: boolean;
  estimate: Estimate;
  problems: Array<{ line: number; reason: string }>;
  warnings: string[];
};

export type RowStatus = { person?: CellStatus; company?: CellStatus; confidence?: number; note?: string; employerDomain?: string };

export type CacheEntry = { data: unknown; status: string; credits: number; at: string; fields?: string[] };

export interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

export type CostSummary = { credits: number; byEndpoint: Record<string, number>; cached: number; calls: number };
