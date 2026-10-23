// The top bar: logo, a thin rule, the tool name; on the right the code and the key.
import { GithubLogoIcon, KeyIcon } from "@phosphor-icons/react";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function TopBar({ repo, onHome, keyTail, onKey }: { repo: string; onHome: () => void; keyTail: string; onKey: () => void }) {
  return (
    <header className="border-b border-rule bg-white">
      <div className="mx-auto grid h-[64px] max-w-[1280px] grid-cols-[1fr_auto] items-center gap-3 px-5 sm:px-6">
        <div className="flex min-w-0 items-center">
          <a href="https://crustdata.com" aria-label="Crustdata home" className="shrink-0 rounded-md outline-offset-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${BASE}/crustdata-logo.svg`} alt="Crustdata" width={111} height={22} className="h-[22px] w-auto" />
          </a>
          <span className="hidden items-center sm:flex">
            <span aria-hidden className="ml-[13.8px] mr-[14.2px] h-5 w-px bg-[#d4d3dc]" />
            <a href={`${BASE}/`} onClick={e => { e.preventDefault(); onHome(); }} className="relative top-[0.75px] whitespace-nowrap text-[15px] font-medium text-ink transition hover:text-violet">
              Clay Alternative
            </a>
          </span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <a href={repo} className="btn btn-ghost" aria-label="Get the code on GitHub">
            <GithubLogoIcon size={18} weight="fill" aria-hidden />
            <span className="hidden sm:inline">Get the code</span>
          </a>
          <button type="button" onClick={onKey} className={`btn ${keyTail ? "btn-ghost" : "btn-dark"}`} aria-label="Your Crustdata API key">
            <KeyIcon size={17} weight="bold" aria-hidden />
            <span className={keyTail ? "font-mono text-[13px]" : ""}>{keyTail ? `••••${keyTail}` : "Your key"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
