// BASE_PATH lets the app live under a sub path, for example /tools/company-researcher on crustdata.com.
const basePath = process.env.BASE_PATH || "";

/** @type {import('next').NextConfig} */
export default {
  basePath,
  // A separate build folder for a dev server running next to a production build (NEXT_DIST_DIR=.next-dev).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  images: { unoptimized: true },
};
