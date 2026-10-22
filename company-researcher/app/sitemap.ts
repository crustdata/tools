import type { MetadataRoute } from "next";

// One URL: the tool's own page. Served at BASE_PATH/sitemap.xml, e.g. https://crustdata.com/tools/company-researcher/sitemap.xml.
export default function sitemap(): MetadataRoute.Sitemap {
  const site = new URL(process.env.SITE_URL || "http://localhost:3217").origin;
  const home = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return [{ url: `${site}${home || "/"}`, changeFrequency: "monthly", priority: 1 }];
}
