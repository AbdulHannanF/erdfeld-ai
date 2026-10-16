import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

// The commit evidence bundles record (Q-29). Never guessed: "unknown" when git cannot say.
function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  env: { NEXT_PUBLIC_GIT_SHA: process.env.GIT_SHA || gitSha() },
  // CSP + hardening headers on every response (src/lib/security-headers.ts).
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  // Audit 2026-06-10: was `ignoreBuildErrors: true` (z-ai scaffold remnant, along
  // with a dead `.space-z.ai` allowedDevOrigins entry). `npm run typecheck` is
  // clean, so builds now fail honestly on type errors.
  reactStrictMode: false,
  // onnxruntime-node ships platform-specific native binaries — exclude from webpack
  // so Next.js uses native require() at runtime in API routes.
  // pino / pino-pretty use thread-stream worker transports + dynamic requires that
  // bundlers can't statically resolve — keep them external (P7.2 structured logging).
  // Claim recipes (Q-23) are read from disk at run time; the standalone trace must carry them.
  outputFileTracingIncludes: { "/api/cases": ["./recipes/**"], "/api/cases/[id]": ["./recipes/**"] },
  serverExternalPackages: ["onnxruntime-node", "pino", "pino-pretty", "thread-stream", "@google/earthengine"],
};

export default nextConfig;
