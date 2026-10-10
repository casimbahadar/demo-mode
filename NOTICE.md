# Third-party code in this folder

`mgba_libretro.js` and `mgba_libretro.wasm` are the unmodified mGBA web core from the
EmulatorJS project, package `@emulatorjs/core-mgba` version 4.2.3 (built 14 June 2025),
file `mgba-wasm.data`, extracted from its 7z archive.

- mGBA (the emulator) is under the Mozilla Public License 2.0: `LICENSE-mgba-core.txt`.
  Source: https://github.com/EmulatorJS/mgba (fork of https://github.com/mgba-emu/mgba)
- The core is built into a RetroArch frontend (RetroArch 1.21.0, EmulatorJS build), which is
  under the GNU GPL version 3, the same licence as EmulatorJS: `LICENSE-emulatorjs-gpl3.txt`.
  Source: https://github.com/EmulatorJS/RetroArch and https://github.com/EmulatorJS/EmulatorJS

SHA-256 of the files as shipped:
- mgba_libretro.js   2ce4119631d165ca2c677b37249196113a8a7226c0487063e68877ccf29efd76
- mgba_libretro.wasm b26dee1d3845106e2f1a7e988bd2e9e45a628e285c0af061accc69c92e1f7bcd

The bot's game-memory addresses come from the fireemblem8u decompilation
(https://github.com/FireEmblemUniverse/fireemblem8u) and StanHash's FE-CLib symbol list
(https://github.com/StanHash/FE-CLib). No game data is included. No ROMs are hosted here.
