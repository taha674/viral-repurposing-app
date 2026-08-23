import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg ships native-ish bindings via pg-native optional dep — keep it out of
  // the Server Components/Route Handler bundle and let it load via native
  // require. Same reasoning for the caption-burn deps: ffmpeg-static and
  // ffprobe-static resolve their bundled binary paths via __dirname, and
  // @huggingface/transformers' onnxruntime-node backend does the same for
  // its native .node binding — all break under Turbopack's route-handler
  // bundling (paths resolve against a virtual /ROOT) unless excluded here.
  serverExternalPackages: [
    "pg",
    "ffmpeg-static",
    "ffprobe-static",
    "@huggingface/transformers",
    "fontkit",
  ],
  experimental: {
    // Default request body cap is 10MB, far below a HeyGen reel export — the
    // captions upload route needs room for real video files. Kept in sync
    // with CAPTIONS_MAX_VIDEO_MB's default (lib/config.ts); the route itself
    // still enforces the configured env value on top of this ceiling. This
    // app uses proxy.ts (not middleware.ts), so proxyClientMaxBodySize is
    // the one that applies — not middlewareClientMaxBodySize, despite that
    // being the name in Next's own error message.
    proxyClientMaxBodySize: "500mb",
  },
};

export default nextConfig;
