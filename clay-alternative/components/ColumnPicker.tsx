// The column picker: two panels, Person and Company, each row a checkbox, the label, and the cost per row.
import type { ColumnInfo } from "./types";

export function ColumnPicker({ columns, selected, onToggle, onSet, hasPeople, hasCompanies, needsProfile = false }: {
  columns: ColumnInfo[]; selected: Set<string>; onToggle: (id: string) => void; onSet: (ids: string[]) => void; hasPeople: boolean; hasCompanies: boolean; needsProfile?: boolean;
}) {
  const groups: Array<["Person" | "Company", string, boolean]> = [["Person", "From the person's profile", hasPeople], ["Company", "From the company record", hasCompanies]];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {groups.map(([group, sub, relevant]) => {
        const list = columns.filter(c => c.group === group);
        const picked = list.filter(c => selected.has(c.id)).length;
        return (
          <div key={group} className="panel p-4">
            <div className="flex items-baseline justify-between gap-3 pb-2">
              <div>
                <span className="text-[15px] font-medium">{group} columns</span>
                <span className="ml-2 text-[13px] text-ink-3">{sub}</span>
              </div>
              <span className="flex gap-3 text-[13px] text-ink-2">
                {group === "Company" && <button type="button" className="hover:text-ink" onClick={() => onSet(list.filter(c => c.cost.text === "Free").map(c => c.id))}>Free only</button>}
                <button type="button" className="hover:text-ink" onClick={() => onSet(picked === list.filter(c => c.available).length ? [] : list.filter(c => c.available).map(c => c.id))}>
                  {picked === list.filter(c => c.available).length ? "None" : "All"}
                </button>
              </span>
            </div>
            {!relevant && <p className="mb-2 rounded-lg bg-amber-soft px-3 py-2 text-[13px] text-amber">No row in this file has a {group === "Person" ? "person" : "company"} identifier, so these columns would stay empty.</p>}
            {group === "Company" && relevant && needsProfile && <p className="mb-2 text-[13px] text-ink-3">Rows with no domain of their own (profile URLs, personal emails) pay one person lookup to read the employer from the profile; the free columns are then free.</p>}
            <div className="rows">
              {list.map(c => (
                <label key={c.id} className={`flex cursor-pointer items-center gap-3 px-3 py-[7px] ${c.available ? "" : "cursor-not-allowed"}`} title={`${c.endpoint} ${c.path}`}>
                  <input type="checkbox" className="box" checked={selected.has(c.id)} disabled={!c.available} onChange={() => onToggle(c.id)} />
                  <span className={`flex-1 text-[14px] ${c.available ? "" : "text-ink-3"}`}>{c.label}<span className="ml-2 hidden text-[12px] text-ink-3 lg:inline">{c.note !== "Free" && c.note !== c.label ? c.note : ""}</span></span>
                  <span className={`tag ${c.cost.text === "Free" ? "tag-green" : c.available ? "tag-muted" : "tag-amber"}`}>{c.cost.text}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
