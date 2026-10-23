import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// The same faces as crustdata.com: Inter (400 body, 500 headings, 600 numbers) and JetBrains Mono for code.
const sans = Inter({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains" });

const TITLE = "Clay Alternative: open-source CSV enrichment built on Crustdata";
const DESCRIPTION =
  "Drop a CSV of work emails, company domains or profile URLs, pick person and company columns, watch the table fill in from Crustdata (1B+ profiles, 60M+ companies), export. Open source, one API key, no AI key.";
const REPO = "https://github.com/crustdata/tools/tree/main/clay-alternative";
const OG_ALT = "Clay Alternative: a CSV of work emails enriched with title, company, headcount, industry and funding from Crustdata, with the match counts above the table";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL || "http://localhost:3218"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Clay Alternative",
  keywords: ["clay alternative", "open source clay alternative", "fire-enrich alternative", "csv enrichment", "lead enrichment", "data enrichment tool", "Crustdata API"],
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", siteName: "Clay Alternative", images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: OG_ALT }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/opengraph-image.png"] },
};

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  name: "Clay Alternative",
  description: DESCRIPTION,
  codeRepository: REPO,
  url: process.env.SITE_URL || undefined,
  image: "/opengraph-image.png",
  keywords: "clay alternative, open source clay alternative, fire-enrich alternative, csv enrichment, lead enrichment, Crustdata API",
  isPartOf: { "@type": "SoftwareSourceCode", name: "Crustdata Tools", codeRepository: "https://github.com/crustdata/tools" },
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
