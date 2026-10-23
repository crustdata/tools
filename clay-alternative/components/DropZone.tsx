// The empty state's input: drop or browse a CSV, paste a list, or load one of the three samples.
import { useRef, useState } from "react";
import { FileCsvIcon, ClipboardTextIcon } from "@phosphor-icons/react";

export type SampleKind = "emails" | "domains" | "profile-urls";
export const SAMPLE_LABELS: Record<SampleKind, string> = { emails: "5 work emails", domains: "10 company domains", "profile-urls": "5 profile URLs" };

export function DropZone({ onFile, onPaste, onSample, error }: { onFile: (f: File) => void; onPaste: (text: string) => void; onSample: (k: SampleKind) => void; error?: string }) {
  const [over, setOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="frame rise">
      <div className="panel p-2">
        {!pasting ? (
          <div
            role="button" tabIndex={0} aria-label="Drop a CSV here or browse"
            onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
            onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-[10px] px-6 py-12 text-center transition ${over ? "bg-[#ebe9fb]" : "bg-row hover:bg-row-hover"}`}>
            <FileCsvIcon size={30} weight="duotone" className="text-ink-2" aria-hidden />
            <p className="mt-3 text-[15px] font-medium">Drop a CSV here, or browse</p>
            <p className="mt-1 text-[13px] text-ink-2">Work emails, company domains or profile URLs. HubSpot, Salesforce, Attio and Sheets exports work as they are.</p>
            <input ref={input} type="file" accept=".csv,text/csv,.txt,.tsv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
          </div>
        ) : (
          <div className="rounded-[10px] bg-row p-3">
            <textarea value={text} onChange={e => setText(e.target.value)} rows={6} autoFocus spellCheck={false}
              placeholder={"One per line: a work email, a company domain or a profile URL\njane@acme.example\nnorthwind.example"}
              className="w-full resize-y rounded-lg bg-white px-3.5 py-3 font-mono text-[13px] outline-none ring-violet/40 placeholder:text-ink-3 focus:ring-2" />
            <div className="mt-2 flex items-center justify-between gap-3">
              <button type="button" onClick={() => setPasting(false)} className="text-[13px] text-ink-2 hover:text-ink">Back to the file drop</button>
              <button type="button" disabled={!text.trim()} onClick={() => onPaste(text)} className="btn btn-dark">Use this list</button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 pb-2 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-ink-3">Try a sample:</span>
            {(Object.keys(SAMPLE_LABELS) as SampleKind[]).map(k => (
              <button key={k} type="button" onClick={() => onSample(k)} className="btn btn-ghost !px-3.5 !py-1.5 !text-[13px]">{SAMPLE_LABELS[k]}</button>
            ))}
          </div>
          {!pasting && (
            <button type="button" onClick={() => setPasting(true)} className="flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
              <ClipboardTextIcon size={16} aria-hidden /> or paste a list
            </button>
          )}
        </div>
        {error && <p className="px-3 pb-2 text-[13px] text-down">{error}</p>}
      </div>
    </div>
  );
}
