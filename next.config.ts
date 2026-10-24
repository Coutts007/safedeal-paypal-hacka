import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Playwright server builds into its own folder so it never clashes with `npm run dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
