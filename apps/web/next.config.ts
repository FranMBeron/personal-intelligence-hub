import type { NextConfig } from "next";

const nextConfig = {
  experimental: {
    useTypeScriptCli: false,
  },
} satisfies NextConfig;

export default nextConfig;
