import type { NextConfig } from "next";

const nextConfig = {
  experimental: {
    useTypeScriptCli: false,
  },
  turbopack: {},
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
} satisfies NextConfig;

export default nextConfig;
