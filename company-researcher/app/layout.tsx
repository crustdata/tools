import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// The same faces as crustdata.com: Inter (400 body, 500 headings, 600 numbers) and JetBrains Mono for code.
const sans = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains" });

const TITLE = "Crustdata Company Researcher: open source company research agent";
const DESCRIPTION =
  "Enter a company domain, get a research brief: headcount by department and region over 24 months, hiring, new executives, funding, web traffic, tech stack and news. Open source, built on the Crustdata API.";
const REPO = "https://github.com/crustdata/tools/tree/main/company-researcher";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || "http://localhost:3217"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Crustdata Company Researcher",
  keywords: ["company research agent", "open source", "company research tool", "headcount by department", "hiring signals", "firmographics", "Crustdata API", "Exa company researcher alternative"],
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", siteName: "Crustdata Company Researcher" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

// Structured data so search and answer engines know this is open source software, and where its code lives.
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  name: "Crustdata Company Researcher",
  description: DESCRIPTION,
  codeRepository: REPO,
  programmingLanguage: "TypeScript",
  license: "https://opensource.org/licenses/MIT",
  author: { "@type": "Organization", name: "Crustdata", url: "https://crustdata.com" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
        {children}
      </body>
    </html>
  );
}
