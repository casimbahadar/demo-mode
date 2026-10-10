# Demo Mode

Pick a ROM on your phone and watch a bot play it in the browser. The ROM is read from the
file you pick, stored in this browser (IndexedDB) on this phone, and never uploaded.

## Put it on GitHub Pages
1. Make a repo (for example `demo-mode`) and upload every file in this folder to its top level.
2. Settings, Pages: deploy from the main branch, root folder.
3. Open https://casimbahadar.github.io/demo-mode/ in Safari, then Share, Add to Home Screen.

## Files
- `index.html` the page: ROM list, watch screen, controls.
- `core.js` emulator layer: runs N frames per screen refresh, finds the game's RAM, presses buttons,
  save states, wake lock, on-phone storage.
- `bot-fe.js` the GBA Fire Emblem bot (FE8 US now).
- `mgba_libretro.js`, `mgba_libretro.wasm` the emulator core (see NOTICE.md).

## Notes
- Sound plays at 1x only, after you tap Sound (Safari's rule).
- Saver keeps the speed at 2x or less to save battery and heat.
- Rewind goes back one bot action (up to 30).
- The run is saved every minute and when Safari hides the page; Continue picks it up.
- In-game save files are not kept between visits; the saved run (a save state) is what continues.
- The page must be served over https (GitHub Pages is) or from localhost.
