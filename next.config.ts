import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel serverless functions need longer timeout for Claude API calls
  serverExternalPackages: ["@slack/bolt"],
};

export default nextConfig;
