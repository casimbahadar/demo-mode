// Demo Mode core layer.
// Owns the emulator's main loop so the page decides how many frames run per screen refresh,
// and gives bots one interface: read memory, press buttons, run frames, save and load states.
// Load this file BEFORE mgba_libretro.js.
"use strict";

const WS = (() => {
  // ---- Frame scheduler -------------------------------------------------------------
  // The emulator asks for requestAnimationFrame each frame. We queue those requests and
  // run them ourselves, `speed` times per real screen refresh, calling the bot after each.
  const realRAF = window.requestAnimationFrame.bind(window);
  let queue = [];
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };

  const ws = {
    speed: 1,
    paused: false,
    hiddenPause: false,   // Safari stopped the page while it was in the background
    frame: 0,             // frames run since boot
    onFrame: null,        // called after every emulated frame (the bot's step)
    onTick: null,         // called once per screen refresh (UI updates)
    M: null,
    rom: null,
    romView: null,
    started: false,
  };

  function tick(t) {
    realRAF(tick);
    if (ws.started && !ws.paused && !ws.hiddenPause) {
      for (let i = 0; i < ws.speed; i++) {
        const q = queue; queue = [];
        if (!q.length) break;
        for (const cb of q) cb(t);
        ws.frame++;
        if (ws.onFrame) {
          try { ws.onFrame(); } catch (e) { console.error(e); }
        }
      }
    }
    if (ws.onTick) { try { ws.onTick(); } catch (e) { console.error(e); } }
  }
  realRAF(tick);

  // ---- Audio ------------------------------------------------------------------------
  // Record every AudioContext the core creates so sound can be started after a tap
  // (Safari's rule) and stopped when the speed is above 1x, where it would be garbled.
  const audioContexts = [];
  for (const name of ["AudioContext", "webkitAudioContext"]) {
    const Orig = window[name];
    if (!Orig) continue;
    window[name] = function (...args) { const c = new Orig(...args); audioContexts.push(c); return c; };
    window[name].prototype = Orig.prototype;
  }
  ws.soundWanted = false;
  ws.applySound = () => {
    const on = ws.soundWanted && ws.speed === 1 && !ws.paused;
    for (const c of audioContexts) {
      try { if (on) c.resume(); else c.suspend(); } catch (e) { /* ignore */ }
    }
  };

  // ---- Boot ------------------------------------------------------------------------
  ws.boot = async (romBytes, canvas, parent) => {
    ws.rom = romBytes;
    ws.romView = new DataView(romBytes.buffer, romBytes.byteOffset, romBytes.byteLength);
    const M = await window.EJS_Runtime({
      noInitialRun: true, canvas, parent, arguments: [], preRun: [], postRun: [], callbacks: {},
      print: () => {}, printErr: () => {}, totalDependencies: 0,
      locateFile: (f) => f, getSavExt: () => ".srm",
    });
    ws.M = M;
    const mk = (p) => { try { M.FS.mkdir(p); } catch (e) { /* exists */ } };
    ["/home", "/home/web_user", "/home/web_user/.config", "/home/web_user/.config/retroarch",
     "/data", "/data/saves"].forEach(mk);
    // audio_sync off: otherwise RetroArch holds the game at 60 frames per second and speed does nothing.
    // video_vsync on: with it off, RetroArch switches its loop to setTimeout and bypasses our scheduler.
    M.FS.writeFile("/home/web_user/.config/retroarch/retroarch.cfg",
      'savefile_directory = "/data/saves"\nvideo_vsync = "true"\nvideo_smooth = "false"\n' +
      'audio_sync = "false"\naudio_latency = 64\nrewind_enable = "false"\n');
    M.FS.writeFile("/game.gba", romBytes);
    ws.fn = {
      stateInfo: M.cwrap("save_state_info", "string", []),
      loadState: M.cwrap("load_state", "number", ["string", "number"]),
      input: M.cwrap("simulate_input", "null", ["number", "number", "number"]),
      restart: M.cwrap("system_restart", "", []),
    };
    M.callMain(["/game.gba"]);
    M.resumeMainLoop();
    ws.started = true;
    ws.applySound();
  };

  // ---- Input ------------------------------------------------------------------------
  const KEY = { B: 0, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, L: 10, R: 11 };
  const held = new Set();
  ws.setKey = (name, down) => {
    if (!ws.fn) return;
    ws.fn.input(0, KEY[name], down ? 1 : 0);
    if (down) held.add(name); else held.delete(name);
  };
  ws.releaseAll = () => { for (const k of [...held]) ws.setKey(k, false); };

  // ---- Memory -----------------------------------------------------------------------
  // The core has no memory-read function, so we find the live GBA RAM inside the
  // WebAssembly heap: take a save state, then search the heap for the state's copy of
  // IWRAM (32 KB) with EWRAM (256 KB) directly before it, as mGBA allocates them.
  let ewramBase = -1, iwramBase = -1;
  ws.memReady = () => ewramBase >= 0;
  ws.invalidateMemory = () => { ewramBase = -1; iwramBase = -1; };

  ws.locateMemory = () => {
    const M = ws.M;
    const [sz, p] = ws.fn.stateInfo().split("|").map(Number);
    const st = M.HEAPU8.slice(p, p + sz);
    // RetroArch wraps the core state: "RASTATE" + version, then a "MEM " block.
    if (String.fromCharCode(...st.subarray(8, 12)) !== "MEM ") return false;
    const core = st.subarray(16);
    const IW = 0x19000, EW = 0x21000; // mGBA state layout: IWRAM, then EWRAM
    const iw = core.subarray(IW, IW + 0x8000), ew = core.subarray(EW, EW + 0x40000);
    const H = M.HEAPU8;
    // Find a 32-byte window of IWRAM with plenty of distinct values to search for.
    let off = -1;
    for (let o = 0x100; o < 0x7F00; o += 64) {
      if (new Set(iw.subarray(o, o + 32)).size >= 16) { off = o; break; }
    }
    if (off < 0) return false;
    const w = iw.subarray(off, off + 32);
    let i = -1;
    while ((i = H.indexOf(w[0], i + 1)) >= 0) {
      let ok = true;
      for (let j = 1; j < 32; j++) if (H[i + j] !== w[j]) { ok = false; break; }
      if (!ok) continue;
      const ib = i - off;
      if (ib >= p && ib < p + sz) continue; // the state buffer itself
      const eb = ib - 0x40000;
      if (eb < 0) continue;
      let same = true;
      for (let j = 0; j < 0x8000 && same; j += 1) if (H[ib + j] !== iw[j]) same = false;
      for (let j = 0; j < 0x40000 && same; j += 1) if (H[eb + j] !== ew[j]) same = false;
      if (same) { iwramBase = ib; ewramBase = eb; return true; }
    }
    return false;
  };

  function hostAddr(a) {
    if (a >= 0x02000000 && a < 0x02040000) return ewramBase + (a - 0x02000000);
    if (a >= 0x03000000 && a < 0x03008000) return iwramBase + (a - 0x03000000);
    return -1;
  }
  ws.r8 = (a) => {
    if (a >= 0x08000000) { const o = a - 0x08000000; return o < ws.rom.length ? ws.rom[o] : 0; }
    const h = hostAddr(a); return h < 0 ? 0 : ws.M.HEAPU8[h];
  };
  ws.s8 = (a) => { const v = ws.r8(a); return v > 127 ? v - 256 : v; };
  ws.r16 = (a) => ws.r8(a) | (ws.r8(a + 1) << 8);
  ws.s16 = (a) => { const v = ws.r16(a); return v > 32767 ? v - 65536 : v; };
  ws.r32 = (a) => (ws.r16(a) | (ws.r16(a + 2) << 16)) >>> 0;

  // ---- Save states ------------------------------------------------------------------
  ws.saveState = () => {
    const [sz, p] = ws.fn.stateInfo().split("|").map(Number);
    return ws.M.HEAPU8.slice(p, p + sz);
  };
  ws.loadState = (bytes) => {
    ws.releaseAll();
    try { ws.M.FS.unlink("/game.state"); } catch (e) { /* none */ }
    ws.M.FS.writeFile("/game.state", bytes);
    ws.fn.loadState("game.state", 0);
    ws.invalidateMemory();
  };

  // ---- Screen wake lock -------------------------------------------------------------
  let wakeLock = null;
  ws.keepAwake = async (on) => {
    try {
      if (on && "wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && ws.started) { ws.hiddenPause = true; ws.releaseAll(); }
  });

  // ---- On-phone storage (IndexedDB) -------------------------------------------------
  // ROMs and run snapshots are stored in this browser on this phone. Nothing is uploaded.
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("demo-mode", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("roms", { keyPath: "id" });
        r.result.createObjectStore("runs", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const req = fn(s); t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  }
  ws.store = {
    put: (store, obj) => tx(store, "readwrite", (s) => s.put(obj)),
    get: (store, id) => tx(store, "readonly", (s) => s.get(id)),
    del: (store, id) => tx(store, "readwrite", (s) => s.delete(id)),
    all: (store) => tx(store, "readonly", (s) => s.getAll()),
  };

  return ws;
})();
