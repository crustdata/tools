// The top bar: full width, divided from the page by one hairline from edge to edge. On the left the Crustdata logo,
// a thin vertical rule and the product name, which leads back to the start; on the right the code and the key.
import { ArrowUpRightIcon, GithubLogoIcon } from "@phosphor-icons/react";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function TopBar({ repo, onHome }: { repo: string; onHome: () => void }) {
  return (
    <header className="border-b border-[#e7e7ec] bg-white">
      <div className="mx-auto grid h-[64px] max-w-[1240px] grid-cols-[1fr_auto] items-center gap-3 px-5 sm:px-6">
        <div className="flex min-w-0 items-center">
          <a href="https://crustdata.com" aria-label="Crustdata home" className="shrink-0 rounded-md outline-offset-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${BASE}/crustdata-logo.svg`} alt="Crustdata" width={111} height={22} className="h-[22px] w-auto" />
          </a>
          {/* Equal space either side of the rule, measured ink to ink: 15px from the logo's last letter to the rule and 15px from the rule to the C (the logo file and the C each carry about 1px of their own padding). */}
          <span className="hidden items-center sm:flex">
            <span aria-hidden className="ml-[13.8px] mr-[14.2px] h-5 w-px bg-[#d4d3dc]" />
            <a href={`${BASE}/`} onClick={e => { e.preventDefault(); onHome(); }}
              className="relative top-[0.75px] whitespace-nowrap text-[15px] font-medium text-ink transition hover:text-violet">
              Company Researcher
            </a>
          </span>
        </div>

        <div className="flex items-center justify-end gap-1.5">
          <a href={repo} aria-label="Get the code on GitHub"
            className="flex items-center gap-2 rounded-full px-3 py-2 text-[14px] font-medium text-ink shadow-[inset_0_0_0_1px_rgba(18,17,24,.14)] transition hover:bg-wash sm:px-3.5">
            <GithubLogoIcon size={18} weight="fill" aria-hidden />
            <span className="hidden sm:inline">Get the code</span>
          </a>
          <a href="https://app.crustdata.com" title="Start free with $20 in credits"
            className="flex items-center gap-1.5 rounded-full bg-violet px-4 py-2 text-[14px] font-semibold text-white transition hover:bg-[#3f37c2]">
            Get API key<ArrowUpRightIcon size={14} weight="bold" aria-hidden />
          </a>
        </div>
      </div>
    </header>
  );
}
