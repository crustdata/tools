// Number and date formatting shared by the brief, the markdown and the UI.

export const int = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : Math.round(n).toLocaleString("en-US"));

export function pct(n: number | null | undefined, signed = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  // Round the size, then put the sign back, so -12.5 and +12.5 both become 13.
  const a = Math.abs(n);
  const v = Math.sign(n) * (a < 10 ? Math.round(a * 10) / 10 : Math.round(a));
  const s = `${Math.abs(v)}%`;
  if (!signed) return s;
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : "0%";
}

// "up 29%" / "down 11%" / "flat"
export function trend(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  const s = pct(n, false);
  return Math.abs(n) < 0.5 ? "flat" : n > 0 ? `up ${s}` : `down ${s}`;
}

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  const abs = Math.abs(n);
  const fmt = (v: number, unit: string) => `$${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
  if (abs >= 1e9) return fmt(n / 1e9, "B");
  if (abs >= 1e6) return fmt(n / 1e6, "M");
  if (abs >= 1e3) return fmt(n / 1e3, "K");
  return `$${Math.round(n)}`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return int(n);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthYear(d: string | null | undefined): string {
  if (!d) return "n/a";
  const [y, m] = d.split("-");
  return `${MONTHS[Number(m) - 1] ?? ""} ${y}`.trim();
}

export function daysBetween(a: string, b: Date): number {
  return (b.getTime() - new Date(a).getTime()) / 86400_000;
}

export const credits = (n: number) => (Math.round(n * 100) / 100).toString();

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// One date format across the page: "Oct 9" within the current year, "Sep 2025" otherwise.
export function shortDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m) return iso;
  return y === now.getUTCFullYear() && d ? `${SHORT[m - 1]} ${d}` : `${SHORT[m - 1]} ${y}`;
}
// Month and year only, for start dates: "Apr 2020".
export function monthShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  return y && m ? `${SHORT[m - 1]} ${y}` : "";
}
