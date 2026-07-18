import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it out of the Server Components/
  // Route Handler bundle and let it load via native require.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
