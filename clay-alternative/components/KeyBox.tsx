// Bring your own key: held in this browser for the session (or remembered on this device), sent per request in a
// header, never logged. Checked with one free call before it is used.
import { useEffect, useState } from "react";

function keyProblem(k: string): string | null {
  if (k.length > 512) return "That is longer than any API key. Check what you pasted.";
  if (!/^[\x21-\x7e]+$/.test(k)) return "That key has characters an API key cannot contain. Check what you pasted.";
  return null;
}

export function KeyBox({ value, serverKey, onUse, onRemove, onClose, verify, remember, setRemember }: {
  value: string; serverKey: boolean; onUse: (k: string) => void; onRemove: () => void; onClose: () => void;
  verify: (k: string) => Promise<string>; remember: boolean; setRemember: (r: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [show, setShow] = useState(false);
  const [check, setCheck] = useState<{ status: "idle" | "checking" | "ok" | "bad"; note?: string }>({ status: "idle" });
  useEffect(() => setDraft(value), [value]);
  const save = async () => {
    const k = draft.trim();
    if (!k) return;
    const problem = keyProblem(k);
    if (problem) { setCheck({ status: "bad", note: problem }); return; }
    setCheck({ status: "checking" });
    try { const note = await verify(k); onUse(k); setCheck({ status: "ok", note }); }
    catch (err) { setCheck({ status: "bad", note: (err as Error).message }); }
  };
  return (
    <div className="frame rise mt-4 text-left">
      <div className="flex items-center justify-between px-4 pb-2.5 pt-3">
        <span className="text-[15px] font-medium">Your Crustdata API key</span>
        <button type="button" onClick={onClose} className="text-[13px] text-ink-2 hover:text-ink">Close</button>
      </div>
      <div className="panel p-5">
        <p className="text-[13px] leading-relaxed text-ink-2">
          {serverKey ? "Optional: this deployment runs on its owner's key. With your own key the runs are billed to you and credit numbers are shown. " : "This deployment has no key of its own, so you need yours. "}
          Get one at <a href="https://app.crustdata.com" target="_blank" rel="noreferrer" className="text-violet hover:underline">app.crustdata.com</a>.
        </p>
        <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); save(); }}>
          <div className="relative min-w-0 flex-1">
            <input id="cd-key" type={show ? "text" : "password"} value={draft} onChange={e => { setDraft(e.target.value); setCheck({ status: "idle" }); }}
              placeholder="Paste your key" autoComplete="off" spellCheck={false} aria-invalid={check.status === "bad" || undefined}
              className="w-full rounded-xl bg-row px-3.5 py-2.5 pr-14 font-mono text-[13px] outline-none transition placeholder:text-ink-3 focus:bg-white focus:ring-2 focus:ring-violet/40 aria-[invalid]:ring-2 aria-[invalid]:ring-down/50" />
            <button type="button" onClick={() => setShow(!show)} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[12px] text-ink-2 hover:text-ink">{show ? "Hide" : "Show"}</button>
          </div>
          <button type="submit" disabled={!draft.trim() || check.status === "checking"} className="btn btn-dark">{check.status === "checking" ? "Checking..." : "Check and use"}</button>
        </form>
        <div className="mt-2 min-h-[20px] text-[13px]">
          {check.note && <p className={check.status === "bad" ? "text-down" : "text-violet"}>{check.note}</p>}
          {value && !check.note && <p className="text-ink-2">In use: <span className="font-mono">••••{value.slice(-4)}</span> <button type="button" onClick={() => { onRemove(); setDraft(""); setCheck({ status: "idle" }); }} className="ml-2 underline underline-offset-2 hover:text-down">Remove</button></p>}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="box" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember on this device</label>
          <p className="text-[13px] text-ink-3">The key stays in this browser and goes with each run only to make the calls. The server never stores or logs it.</p>
        </div>
      </div>
    </div>
  );
}
