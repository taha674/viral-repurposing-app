import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg ships native-ish bindings via pg-native optional dep — keep it out of
  // the Server Components/Route Handler bundle and let it load via native require.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
