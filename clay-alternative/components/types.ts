// Shapes the page gets from the API routes.
export type ColumnInfo = {
  id: string; label: string; group: "Person" | "Company"; note: string; path: string; endpoint: string; source: string;
  cost: { each: number | null; per: "row" | "person" | "company"; text: string }; available: boolean;
};
export type Check = {
  ok: boolean; needsKey?: boolean; serverKey: boolean; maxRows: number; pricing: "shown" | "hidden"; own?: boolean;
  credits?: number | null; emailColumn?: boolean; emailLookup?: boolean | "unknown"; error?: string;
};
