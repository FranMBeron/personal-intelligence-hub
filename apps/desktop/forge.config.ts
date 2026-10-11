import type { ForgeConfig } from "@electron-forge/shared-types";

const config = {
  outDir: "out",
  packagerConfig: {
    asar: true,
    name: "Personal Intelligence Hub",
    executableName: "personal-intelligence-hub",
    appBundleId: "org.personal-intelligence-hub.desktop",
    icon: "assets/icon",
    // Vite bundles every runtime dependency. Copy only its runtime output.
    ignore: (file: string): boolean => {
      if (["", "/package.json", "/.vite", "/.vite/build", "/.vite/renderer",
        "/.vite/renderer/assets"].includes(file)) return false;
      return !/^\/\.vite\/(?:build\/(?:main|preload)\.cjs|renderer\/index\.html|renderer\/assets\/[\w.-]+\.(?:js|css|png|svg|webp|woff2?))$/u.test(file);
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: (arch: string) => {
        if (arch !== "arm64") throw new Error("The unsigned macOS DMG supports arm64 only");
        return { format: "ULFO", name: "Personal Intelligence Hub" };
      },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
          { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
        ],
        renderer: [
          { name: "control_window", config: "vite.renderer.config.ts" },
        ],
      },
    },
  ],
} satisfies ForgeConfig;

export default config;
