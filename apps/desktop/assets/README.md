# Desktop brand assets

Both images derive only from `apps/web/public/favicon.svg`.

- `icon.icns` preserves the favicon background and glyph. It contains PNG
  representations at 16, 32, 64, 128, 256, 512, and 1024 pixels, stored in the
  standard `icp4`, `icp5`, `icp6`, `ic07`, `ic08`, `ic09`, and `ic10` ICNS entries.
- `tray-template.png` uses the same glyph in black, without the background, at
  22 pixels with transparency. Its SVG viewport is `10 8 44 44` so the glyph
  remains legible in the menu bar. The application marks it as a macOS template
  image; macOS supplies the appropriate menu bar color. The PNG is imported as
  an inline Vite asset so the tray does not depend on a source asset directory
  being copied into the installed application.

Rasterization used Sharp. Every PNG contains only `IHDR`, `IDAT`, and `IEND`
chunks. The ICNS container contains only those PNG representations. No creator,
filesystem, timestamp, text, or other metadata is retained.
# Packaging dependency compatibility

The workspace pins the patched image parser used by Forge's DMG tool. The
small `patches/appdmg@0.6.6.patch` adapter preserves the upstream callback
contract with `image-size` 2's asynchronous file API, including custom DMG
backgrounds. Recheck a DMG with a background image when updating that patch.
