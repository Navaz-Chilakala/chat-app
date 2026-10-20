import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const config: NextConfig = {
  // Native / WASM / heavy modules stay external (loaded from node_modules at runtime, not bundled).
  serverExternalPackages: ["pg", "unpdf", "mammoth", "bcryptjs", "@napi-rs/canvas", "tesseract.js", "@tesseract.js-data/eng", "word-extractor", "undici"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default config;
