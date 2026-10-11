// Build scaffold; application behavior and macOS makers are added in later tasks.
export default {
  packagerConfig: {
    asar: true,
    name: "Personal Intelligence Hub",
    executableName: "personal-intelligence-hub",
    appBundleId: "org.personal-intelligence-hub.desktop",
  },
  makers: [],
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
};
