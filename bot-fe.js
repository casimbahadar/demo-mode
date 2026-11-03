// Demo Mode bot for GBA Fire Emblem (FE8 US first).
// It only reads game memory and presses buttons. Battles: it plans each player unit's
// move (targeting, retreating, seizing). Outside battle: simple scripted presses.
// Addresses come from the fireemblem8u decompilation and StanHash's FE-CLib symbol list.
"use strict";

const FE_GAMES = {
  BE8E: {
    name: "Fire Emblem: The Sacred Stones (US)",
    procPool: 0x02024E68, procCount: 64, procSize: 0x6C,
    proc: {
      playerPhase: 0x0859AAD8, menu: 0x085B64D0, target: 0x085B655C, mapEvent: 0x08591AC0,
      battleEvent: 0x08591AF8, dialogue: 0x08591358, textChoice: 0x085914B0, popup: 0x085921C8,
      cpPhase: 0x085A7F08, berserk: 0x085A7F30, ekrBattle: 0x085B9378, battle: 0x0859DABC,
      prep: 0x0859DBBC, mapMain: 0x0859A1F0, phaseGfx: 0x0859AF80,
      difficulty: 0x08A20A10, // "Select Mode" on New Game; +0x30 = current choice
      shop: 0x08A39210,       // armory/vendor screen
    },
    idle: { mainIdle: 0x0801C941, rangeIdle: 0x0801CD1D, worldMap: 0x080B9805,
      shopEntry: 0x080B4351, shopBuyList: 0x080B44A9, // read off gProc_Shop's PROC_REPEAT steps
      tradeIdle: 0x0802D835, tradeHolding: 0x0802D981,
      supplyGiveTake: 0x0809DCD5, supplyList: 0x0809E421, supplyUnitInv: 0x0809E975 }, // convoy: Give/Take box, convoy list, own items // trade screen: nothing picked up / item picked up
    gold: 0x0202BCF8,
    // World map: gGMData (cursor at +0x08/+0x0C in 1/256 pixels) and the node table
    // (32-byte records: chapter +0x04, x/y +0x18/+0x1A), found by matching Ide's record.
    gmData: 0x03005280, wmNodes: 0x082060B0, wmNodeCount: 0x1C,
    chapterData: 0x0202BCF0, cursor: 0x0202BCC4, activeUnit: 0x03004E50,
    units: { blue: [0x0202BE4C, 62], red: [0x0202CFBC, 50], green: [0x0202DDCC, 20] },
    mapSize: 0x0202E4D4, mapTerrain: 0x0202E4DC, mapMovement: 0x0202E4E0, mapUnit: 0x0202E4D8,
    itemData: 0x08809B10, itemSize: 36,
    lordIds: [0x01, 0x0F], // Eirika, Ephraim
    msg: { dance: 0x67E, supply: 0x68F, trade: 0x68E, rescue: 0x689, drop: 0x68A, armory: 0x685, seize: 0x67A, attack: 0x67B, staff: 0x67C, talk: 0x680, visit: 0x682, chest: 0x683, door: 0x684, pick: 0x694, vendor: 0x686, item: 0x68D, wait: 0x695, end: 0x6A0, use: 0x696 },
    // Chapter table (0x94-byte records): +0x8C goal type 0 seize / 1 rout / 3 boss.
    // Chapter event headers come from the asset table by the record's +0x74 id; +0x04 = talk events.
    chapterTable: 0x088B0890, chapterSize: 0x94, eventAssets: 0x088B363C,
    terrain: { wallDamaged: 0x1B, snag: 0x33, door: 0x1E, chest: 0x21, village: 0x03, armory: 0x06, vendor: 0x07 },
    items: { chestKey: 0x69, doorKey: 0x6A, lockpick: 0x6B, chestKeys: 0x79 },
    promoItems: [0x64, 0x65, 0x66, 0x67, 0x68, 0x88, 0x8A, 0x97, 0x98, 0x99], // crests, seals, braces
    healStaves: { 0x4B: 10, 0x4C: 20, 0x4D: 99, 0x4E: 10, 0x4F: 10 }, // Heal, Mend, Recover, Physic, Fortify: rough HP restored
    vulnerary: 0x6C,
    seizeTerrains: [0x0B, 0x1F, 0x23], // castle gate, throne, gate
  },
};

const US_HIDDEN = 0x1, US_DEAD = 0x4, US_NOT_DEPLOYED = 0x8, US_RESCUED = 0x20, US_HAS_MOVED = 0x40,
  US_UNSELECTABLE = 0x2; // values from fireemblem8u include/bmunit.h

class FEBot {
  constructor(ws, code) {
    this.ws = ws;
    this.g = FE_GAMES[code];
    this.enabled = true;
    this.status = "Starting";
    this.log = [];
    this.wait = 0;
    this.gen = null;
    this.intent = null;
    this.sceneKind = "";
    this.lastSceneChange = 0;
    this.onAction = null;   // callback after each finished player action (for rewind snapshots)
    this.trueHit = FEBot.makeTrueHitTable();
    this.difficulty = 1; // 0 Easy (tutorials), 1 Normal, 2 Difficult
    this.caution = 0;
    this.route = "eirika"; // which lord to follow after Chapter 8    // raised after a rewind, so the bot plays the turn more safely
    this.lastProgress = 0; this.progressKey = ""; this.stuck = false; this.onStuck = null;
    this.textCache = new Map();
  }
  static supports(code) { return !!FE_GAMES[code]; }

  say(text) {
    if (text !== this.status) {
      this.status = text;
      this.log.push(`[${this.ws.frame}] ${text}`); this.logCount = (this.logCount || 0) + 1;
      if (this.log.length > 300) this.log.shift();
    }
  }

  // Called after every emulated frame.
  step() {
    // Find the game's RAM first, even with the bot off, so the status line keeps working.
    if (!this.ws.memReady()) {
      if (this.ws.frame < 30 || this.ws.frame % 30) return;
      if (!this.ws.locateMemory()) return;
    }
    if (!this.enabled) return;
    if (this.ws.frame % 15 === 0) this.watchSpawns();
    if (this.ws.frame % 30 === 0 && this.noteProgress() && !this.stuck) {
      this.stuck = true;
      this.say("The bot seems stuck here. Tap Copy bot log and send it to Claude.");
      if (this.onStuck) this.onStuck();
      this.ws.releaseAll(); this.gen = this.unstick(); this.wait = 0;
    }
    if (this.wait > 0) { this.wait--; return; }
    if (!this.gen) this.gen = this.main();
    try {
      const r = this.gen.next();
      if (r.done) this.gen = null;
      else this.wait = Math.max(0, (r.value | 0) - 1);
    } catch (e) {
      this.say("Bot error, restarting: " + e.message);
      this.log.push("  at " + String(e.stack || "").split("\n").slice(1, 4).map((l) => l.trim()).join(" | "));
      console.error(e);
      this.ws.releaseAll();
      this.gen = null; this.intent = null; this.wait = 10;
    }
  }
  reset() { this._seenRed = null; this.ws.releaseAll(); this.gen = null; this.intent = null; this.wait = 6; this.lastProgress = this.ws.frame; this.stuck = false; this.menuTries = new Map(); }

  // ---- Stuck detection: no new screen, turn, phase or action for 3 minutes of game time
  noteProgress() {
    const key = [this.sceneKind, this.chapter(), this.turn(), this.phase(), this.logCount].join("|");
    if (key !== this.progressKey) { this.progressKey = key; this.lastProgress = this.ws.frame; return false; }
    return this.ws.frame - this.lastProgress > 60 * 180;
  }

  // ---- Game text (names), decoded from the ROM's own Huffman-compressed text table.
  // The table pointer is read from the code that uses it, so text-expanded hacks still work.
  text(id) {
    if (this.textCache.has(id)) return this.textCache.get(id);
    const r8 = (a) => this.r8(a), r16 = (a) => this.r16(a), r32 = (a) => this.r32(a);
    let out = "";
    try {
      const table = r32(0x0800A26C), treeBase = 0x0815A72C, root = r32(0x0815D488);
      let p = r32(table + id * 4);
      const push = (c) => { if (c >= 32 && c < 127) out += String.fromCharCode(c); };
      if (p & 0x80000000) {
        p = (p & 0x7FFFFFFF) | 0x08000000;
        for (let i = 0; i < 64; i++) { const c = r8(p + i); if (!c) break; push(c); }
      } else {
        let node = root, bit = 0, byte = r8(p);
        for (let g = 0; g < 2000; g++) {
          const b = (byte >> bit) & 1;
          if (++bit === 8) { bit = 0; byte = r8(++p); }
          node = treeBase + (b ? r16(node + 2) : r16(node)) * 4;
          const w = r32(node);
          if (w & 0x80000000) {
            const lo = w & 0xFF, hi = (w >> 8) & 0xFF;
            if (!lo) break; push(lo);
            if (w & 0xFF00) { if (!hi) break; push(hi); }
            node = root;
          }
        }
      }
    } catch (e) { out = ""; }
    out = out.trim();
    this.textCache.set(id, out);
    return out;
  }
  // Blue units that have died this chapter, by character id.
  deadBlue() {
    const [base, n] = this.g.units.blue, out = [];
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, ch = this.r32(a);
      if (ch && (this.r32(a + 0x0C) & US_DEAD)) out.push(this.r8(ch + 4));
    }
    return out;
  }
  // Enemy reinforcements: remember where new enemies appear during the enemy's turn. A rewind
  // replays the same turn, so the second time round the bot knows to keep hurt units away.
  watchSpawns() {
    const ch = this.chapter();
    if (this._spawnCh !== ch) { this._spawnCh = ch; this.spawnPts = []; this._seenRed = null; this._pendingSpawn = new Set(); }
    // A slot counts as new only if it was empty before. Enemies are flagged hidden while they walk,
    // and counting hidden ones as gone made every enemy that moved look like a fresh arrival: 40
    // "spawn points" covered Hamill Canyon and the penalty for them pushed Eirika into a corner.
    const [base, n] = this.g.units.red, now = new Map();
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, c = this.r32(a);
      if (c && !(this.r32(a + 0x0C) & US_DEAD)) now.set(a, (this.r32(a + 0x0C) & 0x1) ? null : [this.s8(a + 0x10), this.s8(a + 0x11)]);
    }
    this._pendingSpawn = this._pendingSpawn || new Set();
    if (this._seenRed) for (const a of now.keys()) if (!this._seenRed.has(a)) this._pendingSpawn.add(a); // reinforcements can load in any phase
    for (const a of [...this._pendingSpawn]) {
      const xy = now.get(a);
      if (xy === undefined) { this._pendingSpawn.delete(a); continue; }
      if (xy && xy[0] >= 0) {
        this._pendingSpawn.delete(a);
        if (!this.spawnPts.some((p) => p[0] === xy[0] && p[1] === xy[1])) this.spawnPts.push(xy);
      }
    }
    this._seenRed = now;
    // Last square each enemy character was seen on (to learn where a fleeing recruit leaves the map).
    this.lastSeenRed = this.lastSeenRed || new Map();
    for (const [a, xy] of now) if (xy && xy[0] >= 0) this.lastSeenRed.set(this.r8(this.r32(a) + 4), { x: xy[0], y: xy[1], ch });
  }
  // Called after a death rewind: the unit that died will not end its move on the same square
  // again in that turn (so a retry is a real alternative, not the same losing move).
  noteFailure(charId, turn) {
    const k = `${this.chapter()}:${turn}:${charId}`, sq = this.moveLog && this.moveLog.get(k);
    if (!sq) return;
    this.failedSquares = this.failedSquares || new Set();
    this.failedSquares.add(`${k}@${sq}`);
    // Only the last two bans per unit per turn: with deep rewinds and dozens of retries the bans piled
    // up until every good square was ruled out and Eirika was pushed into the far corner of Hamill
    // Canyon, next to arriving Wyvern Riders.
    const mine = [...this.failedSquares].filter((f) => f.startsWith(`${k}@`));
    for (const f of mine.slice(0, Math.max(0, mine.length - 2))) this.failedSquares.delete(f);
  }
  // Status at +0x30: low 4 bits the condition (1 poison, 2 sleep, 3 silence, 4 berserk, ...),
  // high 4 bits the turns left. A sleeping (or stoned) unit cannot be given orders this turn.
  statusOf(u) { return this.r8(u.addr + 0x30) & 0x0F; }
  cannotAct(u) { const st = this.statusOf(u); return st === 2 || st === 4 || st === 0x0B || st === 0x0D; }
  // Player units alive right now (on the map or not deployed).
  aliveBlue() {
    const [base, n] = this.g.units.blue, out = [];
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, ch = this.r32(a);
      if (ch && !(this.r32(a + 0x0C) & US_DEAD)) out.push(this.r8(ch + 4));
    }
    return out;
  }
  // Hidden unit score (Casim's design): half growth, half current strength.
  //  growth   = stat points gained from level-ups / (level-ups x 7 stats), times the number of level-ups
  //  strength = Str + Skl + Spd + Def + Res + Lck (HP left out)
  // Each half is scaled against the best unit in the army, then averaged.
  unitParts(u) {
    const ch = u.charPtr, cl = u.classPtr;
    const now = [u.maxHP, u.pow, u.skl, u.spd, u.def, u.res, u.lck];
    const charBase = [0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12].map((o) => this.s8(ch + o));
    const classBase = [0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10].map((o) => this.s8(cl + o)).concat([0]); // classes add no luck
    const gained = now.reduce((n, v, i) => n + Math.max(0, v - charBase[i] - classBase[i]), 0);
    const promoted = (this.r32(cl + 0x28) & 0x100) !== 0;
    const levelUps = Math.max(0, this.r8(u.addr + 8) - this.r8(ch + 0x0B) + (promoted ? 10 : 0));
    const growth = levelUps ? (gained / (levelUps * 7)) * levelUps : 0;
    const strength = u.pow + u.skl + u.spd + u.def + u.res + u.lck;
    return { growth, strength };
  }
  // Units Casim rates poorly (Knoll): picked last, and never given the army's promotion items.
  lowPriority(charId) { return ["Knoll"].includes(this.charName(charId)); }
  armyScores(blues) {
    const parts = blues.map((u) => this.unitParts(u));
    const gMax = Math.max(1, ...parts.map((p) => p.growth)), sMax = Math.max(1, ...parts.map((p) => p.strength));
    const out = new Map();
    blues.forEach((u, i) => out.set(u.charId, (0.5 * parts[i].growth / gMax + 0.5 * parts[i].strength / sMax) * (this.lowPriority(u.charId) ? 0.2 : 1)));
    return out;
  }

  // Not-yet-recruited units who can still join (talk targets on the map that are not blue).
  pendingRecruits() {
    const ids = new Set(this.talkPairs().map((p) => p.b)), out = [];
    for (const side of ["green", "red"]) {
      const [base, n] = this.g.units[side];
      for (let i = 0; i < n; i++) {
        const a = base + i * 0x48, ch = this.r32(a);
        // On a Survive map every green ally counts, recruitable or not: they are the ones we defend
        // (Rausten could die quietly in Last Hope, and only Mansel's death later ended the game).
        // (Only the ones by the throne: the ordinary Rausten soldiers on the green side are not wards, and
        // protecting them made every one of their deaths a rewind.)
        const nearThr = () => { if (!this._thr || this._thrCh !== this.chapter()) { this._thrCh = this.chapter(); this._thr = []; const mm = this.map(); for (let y = 0; y < mm.h; y++) for (let x = 0; x < mm.w; x++) if (mm.t[y][x] === 0x1F) this._thr.push({ x, y }); }
          const gx = this.s8(a + 0x10), gy = this.s8(a + 0x11); return this._thr.some((p) => Math.abs(p.x - gx) + Math.abs(p.y - gy) <= 3); };
        // ...and only the uniquely named one (Mansel): the General beside him is named "Rausten" like every
        // soldier, and losing him does not lose the chapter.
        const uniqueName = () => { const nm = this.charName(this.r8(ch + 4)); let c = 0; for (let j = 0; j < n; j++) { const ch2 = this.r32(base + j * 0x48); if (ch2 && this.charName(this.r8(ch2 + 4)) === nm) c++; /* dead soldiers count too */ } return c === 1; };
        // Decided once per chapter, at its start, while all the soldiers are still alive (once the other
        // "Rausten" soldiers had died, the General looked unique too and was protected again).
        this._wardIds = this._wardIds && this._wardIds.ch === this.chapter() ? this._wardIds : { ch: this.chapter(), ids: null };
        // Generic soldiers are named after their army ("Rausten", "Frelia", "Grado"...): never a ward,
        // even when the rest of their squad has died and the name looks unique.
        const generic = () => /^(Rausten|Frelia|Renais|Grado|Jehanna|Carcino|Soldier|Monster|Bandit|Pirate|Remnant)$/.test(this.charName(this.r8(ch + 4)));
        const isWard = () => { if (generic()) return false; if (!this._wardIds.ids) return nearThr() && uniqueName(); return this._wardIds.ids.has(this.r8(ch + 4)); };
        if (ch && !(this.r32(a + 0x0C) & US_DEAD) && (ids.has(this.r8(ch + 4)) || (this.goalType() === 2 && isWard()))) out.push(this.r8(ch + 4));
      }
      break; // green allies only: enemy recruits (Marisa) are not protected
    }
    if (this._wardIds && !this._wardIds.ids && this.goalType() === 2) this._wardIds.ids = new Set(out.filter((id) => !ids.has(id)));
    return out;
  }
  // Enemy recruits whose recruiter is already on our team (Cormag once Eirika is here): protected
  // like our own units, so a rewind can never quietly lose them.
  protectedEnemyRecruits() {
    const pairs = this.talkPairs(), out = [];
    const blue = new Set(this.aliveBlue());
    const [base, n] = this.g.units.red;
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, ch = this.r32(a);
      if (!ch || (this.r32(a + 0x0C) & US_DEAD)) continue;
      const id = this.r8(ch + 4);
      if (pairs.some((p) => p.b === id && blue.has(p.a))) out.push(id);
    }
    return out;
  }
  // The two units in the battle on screen (FE8 gBattleActor / gBattleTarget): who just dropped to 0 HP.
  battleDeaths() {
    const out = [];
    for (const a of [0x0203A4EC, 0x0203A56C]) {
      const ch = this.r32(a);
      if (ch > 0x08000000 && ch < 0x09000000 && this.r8(a + 0x13) === 0) out.push(this.r8(ch + 4));
    }
    return out;
  }
  // A protected recruit vanished from the map: remember where he was last seen.
  noteRecruitExit(id) {
    const p = this.lastSeenRed && this.lastSeenRed.get(id);
    if (!p || p.ch !== this.chapter()) return;
    this.recruitExits = this.recruitExits || new Map();
    this.recruitExits.set(`${this.chapter()}:${id}`, { x: p.x, y: p.y });
    this.say(`${this.charName(id)} left from ${p.x},${p.y}: next try, his talker waits there`);
  }
  // Who is fighting in the battle on screen (both sides), and where every blue unit stands with its HP.
  battleIds() {
    const out = [];
    for (const a of [0x0203A4EC, 0x0203A56C]) { const ch = this.r32(a); if (ch > 0x08000000 && ch < 0x09000000) out.push(this.r8(ch + 4)); }
    return out;
  }
  blueHp() {
    const [base, n] = this.g.units.blue, out = new Map();
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, ch = this.r32(a);
      if (!ch || (this.r32(a + 0x0C) & (US_DEAD | US_NOT_DEPLOYED | 0x20))) continue;
      out.set(this.r8(ch + 4), { hp: this.r8(a + 0x13), x: this.s8(a + 0x10), y: this.s8(a + 0x11), poisoned: (this.r8(a + 0x30) & 0x0F) === 1 });
    }
    return out;
  }
  noteHazard(terrain) {
    this.hazardTerrain = this.hazardTerrain || new Set();
    if (!this.hazardTerrain.has(terrain)) { this.hazardTerrain.add(terrain); this.say(`Terrain ${terrain.toString(16)} hurts units standing on it: avoiding it from now on`); }
  }
  isBooster(id) {
    if (!this._boostIds) {
      const names = ["Angelic Robe", "Energy Ring", "Secret Book", "Speedwings", "Speedwing", "Metiss Tome", "Metis Tome", "Goddess Icon", "Dragonshield", "Talisman", "Boots", "Body Ring", "Swiftsole", "Seraph Robe", "Dracoshield"];
      this._boostIds = new Set();
      for (let i = 1; i < 0xC0; i++) if (names.includes(this.text(this.r16(this.g.itemData + i * this.g.itemSize)))) this._boostIds.add(i);
    }
    return this._boostIds.has(id);
  }
  isStone(id) {
    if (!this._stoneIds) { this._stoneIds = new Set(); for (let i = 1; i < 0xC0; i++) if (this.text(this.r16(this.g.itemData + i * this.g.itemSize)) === "Stone") this._stoneIds.add(i); }
    return this._stoneIds.has(id);
  }
  // Is this character alive on any side?
  aliveAnywhere(id) {
    for (const [side, [base, n]] of Object.entries(this.g.units)) {
      for (let i = 0; i < n; i++) {
        const a = base + i * 0x48, ch = this.r32(a);
        if (ch && this.r8(ch + 4) === id && !(this.r32(a + 0x0C) & US_DEAD)) return true;
      }
    }
    return false;
  }
  // Blue units on the map now, for the "protect units" list.
  roster() {
    // Read the raw array: a unit that is mid-move is flagged hidden but is still on the team.
    const [base, n] = this.g.units.blue, out = [];
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, ch = this.r32(a);
      if (!ch || (this.r32(a + 0x0C) & (US_DEAD | US_NOT_DEPLOYED))) continue;
      const id = this.r8(ch + 4);
      out.push({ id, name: this.text(this.r16(ch)) || "A unit", lord: this.g.lordIds.includes(id) });
    }
    return out;
  }
  charName(id) {
    for (const [side, [base, n]] of Object.entries(this.g.units)) {
      for (let i = 0; i < n; i++) { const ch = this.r32(base + i * 0x48); if (ch && this.r8(ch + 4) === id) return this.text(this.r16(ch)) || "A unit"; }
    }
    // Not on the map any more (for example a would-be recruit who was killed): read the character table.
    return this.text(this.r16(0x08803D30 + id * 0x34)) || "A unit";
  }
  debugDump() {
    let sc = { kind: "?", ps: [] }; try { sc = this.scene(); } catch (e) { /* memory not ready */ }
    return [`scene ${sc.kind}`, `chapter ${this.chapter()} turn ${this.turn()} phase ${this.phase()}`,
      `cursor ${JSON.stringify(this.cursor())} caution ${this.caution}`,
      `procs ${sc.ps.map((p) => p.name || p.script.toString(16)).join(", ")}`, "", ...this.log.slice(-150)].join("\n");
  }

  // ---- Memory helpers ----------------------------------------------------------------
  r8(a) { return this.ws.r8(a); } s8(a) { return this.ws.s8(a); }
  r16(a) { return this.ws.r16(a); } s16(a) { return this.ws.s16(a); } r32(a) { return this.ws.r32(a); }

  procs() {
    const g = this.g, out = [];
    for (let i = 0; i < g.procCount; i++) {
      const p = g.procPool + i * g.procSize;
      const script = this.r32(p);
      if (script) out.push({ addr: p, script, idle: this.r32(p + 0x0C), name: this.procName(p) });
    }
    return out;
  }
  procName(p) {
    const np = this.r32(p + 0x10);
    if (np < 0x08000000 || np >= 0x0A000000) return "";
    let s = "";
    for (let i = 0; i < 24; i++) { const c = this.r8(np + i); if (!c) break; s += c < 32 || c > 126 ? "?" : String.fromCharCode(c); }
    return s;
  }
  phase() { return this.r8(this.g.chapterData + 0x0F); }
  goalType() { return this.r8(this.g.chapterTable + this.chapter() * this.g.chapterSize + 0x8C); }
  // Talk events this chapter: [pidA talks to pidB]. Read from the chapter's own event data (entries are 16 bytes).
  talkPairs() {
    const ch = this.chapter();
    if (this._talkCh === ch) return this._talk;
    const out = [];
    try {
      const id = this.r8(this.g.chapterTable + ch * this.g.chapterSize + 0x74);
      const hdr = this.r32(this.g.eventAssets + id * 4), list = this.r32(hdr + 4);
      for (let i = 0; i < 64 && list >= 0x08000000; i++) {
        const e = list + i * 16, type = this.r16(e); // 16-byte entries: [type][flag][scene][pidA pidB ..][..]
        if (!type) break;
        if (type === 3) out.push({ a: this.r8(e + 8), b: this.r8(e + 9) });
      }
    } catch (e) { /* no talk data */ }
    this._talkCh = ch; this._talk = out;
    return out;
  }
  chapter() { return this.r8(this.g.chapterData + 0x0E); }
  // The game's own chapter title ("Queen of White Dunes"). The raw chapter index doesn't match the
  // printed chapter numbers (Chapter 5x sits at index 5, side chapters elsewhere), so show the title.
  chapterTitle(ch) {
    try { const t = this.text(this.r16(0x088B0890 + ch * 0x94 + 0x70)); return t && t.length < 40 ? t : null; } catch (e) { return null; }
  }
  turn() { return this.r16(this.g.chapterData + 0x10); }
  cursor() { return { x: this.s16(this.g.cursor), y: this.s16(this.g.cursor + 2) }; }

  readUnit(a, side) {
    const ch = this.r32(a);
    if (!ch) return null;
    const cl = this.r32(a + 4);
    const state = this.r32(a + 0x0C);
    const items = [];
    for (let i = 0; i < 5; i++) {
      const v = this.r16(a + 0x1E + i * 2);
      if (v) items.push({ id: v & 0xFF, uses: v >> 8, slot: i });
    }
    const ranks = []; for (let i = 0; i < 8; i++) ranks.push(this.r8(a + 0x28 + i));
    return {
      addr: a, side, charId: this.r8(ch + 4), classId: this.r8(cl + 4), classPtr: cl, charPtr: ch,
      index: this.r8(a + 0x0B), state, x: this.s8(a + 0x10), y: this.s8(a + 0x11),
      maxHP: this.s8(a + 0x12), hp: this.s8(a + 0x13), pow: this.s8(a + 0x14), skl: this.s8(a + 0x15),
      spd: this.s8(a + 0x16), def: this.s8(a + 0x17), res: this.s8(a + 0x18), lck: this.s8(a + 0x19),
      con: this.s8(cl + 0x11) + this.s8(ch + 0x13) + this.s8(a + 0x1A),
      mov: this.s8(cl + 0x12) + this.s8(a + 0x1D), items, ranks,
      name: "",
    };
  }
  units() {
    const out = [];
    for (const [side, [base, n]] of Object.entries(this.g.units)) {
      for (let i = 0; i < n; i++) {
        const u = this.readUnit(base + i * 0x48, side);
        if (!u) continue;
        if (u.state & (US_DEAD | US_NOT_DEPLOYED | US_HIDDEN | US_RESCUED)) continue;
        if (u.hp <= 0) continue;
        out.push(u);
      }
    }
    return out;
  }
  item(id) {
    const a = this.g.itemData + id * this.g.itemSize;
    const eff = this.r32(a + 0x10);
    const effList = [];
    if (eff >= 0x08000000) for (let i = 0; i < 32; i++) { const c = this.r8(eff + i); if (!c) break; effList.push(c); }
    const rng = this.r8(a + 0x19);
    return {
      id, type: this.r8(a + 0x07), attr: this.r32(a + 0x08), might: this.r8(a + 0x15),
      hit: this.r8(a + 0x16), wt: this.r8(a + 0x17), crit: this.r8(a + 0x18),
      min: rng >> 4, max: rng & 0xF, rank: this.r8(a + 0x1C), eff: effList,
    };
  }
  weaponOf(u) {
    for (const it of u.items) {
      const d = this.item(it.id);
      if (!(d.attr & 1) || d.type === 4 || d.type === 8 || d.type === 9 || d.type > 11) continue; // monster claws and dragonstones count // weapons only, no staves
      if (d.rank && u.ranks[d.type] < d.rank) continue;
      if (d.attr & 0x10000) continue; // locked weapons are rare; skip to be safe
      if (this.weaponBan && this.weaponBan.has(`${u.charId}:${it.id}`)) continue; // the game would not let this unit use it
      return d;
    }
    return null;
  }
  // An item this unit has no use for (a weapon it cannot wield, a staff it cannot use, a seal for
  // another class): it can be swapped away in a trade. Healing items and keys are kept.
  // A weapon (or a staff, for a non-healer) this unit cannot use: Eirika carrying Nidhogg, Garm and
  // Vidofnir while Innes had nothing. Boosters, potions, keys and crests are left alone.
  giveSlot(u) {
    const usable = new Set(this.weaponsOf(u).map((w) => w.slot));
    for (const it of u.items) {
      const d = this.item(it.id);
      if (d.type > 7 || usable.has(it.slot)) continue;
      if (d.type === 4 && u.ranks[4]) continue;
      return it.slot;
    }
    return -1;
  }
  // Preparations > Items: hand weapons to the units that can use them, through the convoy. First
  // everyone gives the weapons they cannot use; then units that cannot fight, or that own a legendary
  // weapon sitting in the convoy (Innes: Nidhogg, Gerik: Garm, Tana: Vidofnir, Saleh: Excalibur),
  // take the best one they can use. Legendaries matter for Lyon and the final map (Casim).
  *prepItems() {
    const [base, n] = this.g.units.blue, army = [];
    for (let i = 0; i < n; i++) {
      const a = base + i * 0x48, ch = this.r32(a);
      if (!ch || (this.r32(a + 0x0C) & (US_DEAD | 0x10000))) continue;
      const u = this.readUnit(a, "blue");
      if (u) army.push(u);
    }
    const legendary = new Set(["Sieglinde", "Siegmund", "Nidhogg", "Vidofnir", "Garm", "Excalibur", "Ivaldi", "Gleipnir", "Audhulma", "Latona"]);
    const nm = (id) => this.text(this.r16(this.g.itemData + id * this.g.itemSize));
    const givers = army.filter((u) => this.giveSlot(u) >= 0);
    const pool = new Set(this.convoyItems().map((i) => i.id || i));
    for (const g of givers) for (const it of g.items) if (this.item(it.id).type <= 7 && !this.weaponsOf(g).some((w) => w.slot === it.slot)) pool.add(it.id);
    const takers = army.filter((u) => u.items.length < 5 && this.bestBuy(u, [...pool], 1e9) >= 0 &&
      (!this.weaponsOf(u).length || [...pool].some((id) => legendary.has(nm(id)) && this.bestBuy(u, [id], 1e9) >= 0)));
    if (!givers.length && !takers.length) return;
    this.say(`Sorting weapons: ${givers.map((u) => this.uname(u)).join(", ")} give; ${takers.map((u) => this.uname(u)).join(", ")} take`);
    // Prep main menu: Pick Units, Items, ... (cursor starts on Pick Units). On arrival the screen is
    // still sliding in and early presses are lost (the first real run never reached Items), so wait.
    yield 150;
    yield* this.press("DOWN", 2, 16); yield* this.press("A", 2, 50);
    let cur = 0, onSupplyRow = false;
    const visit = function* (u, mode) {
      const k = army.indexOf(u);
      const dy = Math.floor(k / 3) - Math.floor(cur / 3), dx = (k % 3) - (cur % 3);
      for (let i = 0; i < Math.abs(dy); i++) yield* this.press(dy > 0 ? "DOWN" : "UP", 2, 8);
      for (let i = 0; i < Math.abs(dx); i++) yield* this.press(dx > 0 ? "RIGHT" : "LEFT", 2, 8);
      cur = k;
      yield* this.press("A", 2, 24);                         // the unit's item menu: Trade List / Use Give all / Supply Armory
      // The menu's cursor stays where it was last left, so it is only moved down to Supply the first time.
      if (!onSupplyRow) { yield* this.press("DOWN", 2, 8); yield* this.press("DOWN", 2, 8); onSupplyRow = true; }
      yield* this.press("A", 2, 40);                         // Supply
      this.intent = { kind: "supply", mode, unit: u };
      for (let t = 0; t < 60; t++) {
        const sc = this.scene();
        if (sc.kind !== "supply") break;
        yield* this.onSupply(sc.proc);
      }
      this.intent = null;
      yield 20;
      yield* this.press("B", 2, 24);                         // close the item menu, back to the unit grid
    }.bind(this);
    for (const g of givers) yield* visit(g, "give");
    for (const t of takers) yield* visit(t, "take");
    yield* this.press("B", 2, 30);                            // back to the main preparations menu
    yield 60;                                                 // let it finish sliding in before anything is pressed
    yield* this.press("UP", 2, 20);                           // cursor back on Pick Units
    yield 30;
  }
  junkSlot(u) {
    const keep = new Set([this.g.vulnerary, 0x6D, this.g.items.chestKey, this.g.items.doorKey, this.g.items.lockpick]);
    const usable = new Set(this.weaponsOf(u).map((w) => w.slot));
    for (const it of u.items) {
      if (keep.has(it.id) || usable.has(it.slot)) continue;
      const d = this.item(it.id);
      if (d.type === 4 && u.ranks[4]) continue; // a healer's staff
      if (this.g.promoItems.includes(it.id) && this.r8(u.addr + 8) < 20) continue; // keep crests (may fit later)
      return it.slot;
    }
    return -1;
  }
  // Every weapon this unit can use right now, with its inventory slot.
  weaponsOf(u) {
    const out = [];
    for (const it of u.items) {
      const d = this.item(it.id);
      if (!(d.attr & 1) || d.type === 4 || d.type === 8 || d.type === 9 || d.type > 11) continue; // monster claws and dragonstones count
      if (d.rank && u.ranks[d.type] < d.rank) continue;
      if (d.attr & 0x10000) continue;
      out.push({ ...d, slot: it.slot });
    }
    return out;
  }
  map() {
    const w = this.s16(this.g.mapSize), h = this.s16(this.g.mapSize + 2);
    const rows = this.r32(this.g.mapTerrain);
    const t = [];
    for (let y = 0; y < h; y++) {
      const rp = this.r32(rows + y * 4); const row = [];
      for (let x = 0; x < w; x++) row.push(this.r8(rp + x));
      t.push(row);
    }
    return { w, h, t };
  }

  // ---- Scene detection ---------------------------------------------------------------
  scene() {
    const P = this.g.proc, ps = this.procs();
    const has = (s) => ps.find((p) => p.script === s);
    const menu = has(P.menu), target = has(P.target);
    // Promotion branch choice (a trainee at level 10, or a promotion item with two classes).
    if (ps.some((p) => p.name === "CCRamifyMenuSelect")) {
      const menu = ps.filter((p) => p.script === P.menu).pop();
      if (menu) return { kind: "promoChoice", proc: menu, ps };
    }
    const supply = ps.find((p) => p.idle === this.g.idle.supplyGiveTake || p.idle === this.g.idle.supplyList || p.idle === this.g.idle.supplyUnitInv);
    if (supply && this.intent && this.intent.kind === "supply") return { kind: "supply", proc: supply, ps };
    const trade = ps.find((p) => p.idle === this.g.idle.tradeIdle || p.idle === this.g.idle.tradeHolding);
    if (trade) return { kind: "trade", proc: trade, ps };
    const shop = has(P.shop);
    if (shop) return { kind: "shop", proc: shop, ps };
    if (ps.some((p) => p.idle === this.g.idle.worldMap)) return { kind: "worldmap", ps };
    if (ps.some((p) => p.name === "Gmap Base Menu")) return { kind: "wmMenu", ps };
    // Battle preparations (the "SALLYCURSOR" proc) sit on top of a waiting event, so check first.
    if (has(P.prep) && !has(P.playerPhase)) return { kind: "prep", ps };
    const diff = has(P.difficulty);
    if (diff) return { kind: "difficulty", proc: diff, ps };
    if (target) return { kind: "target", proc: target, ps };
    if (menu) return { kind: "menu", proc: menu, ps };
    if (has(P.textChoice)) return { kind: "choice", ps };
    // Battles first: battle quotes use the event engine too, and Start must not be pressed there.
    if (has(P.ekrBattle) || has(P.battle) || has(P.battleEvent)) return { kind: "battle", talking: !!has(P.dialogue), ps };
    // Easy mode's tutorial runs as an event during the player's turn and dictates every move:
    // just follow it (it puts the cursor where it wants and accepts A).
    if (has(P.mapEvent) && has(P.playerPhase) && !(this.r8(0x0202BD32) & 0x20)) return { kind: "tutorial", ps };
    if (has(P.mapEvent)) return { kind: "event", talking: !!has(P.dialogue), ps };
    if (has(P.dialogue)) return { kind: "dialogue", ps };
    if (has(P.popup)) return { kind: "popup", ps };
    const pp = has(P.playerPhase);
    if (pp) {
      if (pp.idle === this.g.idle.mainIdle) return { kind: "free", ps };
      if (pp.idle === this.g.idle.rangeIdle) return { kind: "moveSelect", ps };
      return { kind: "busy", ps };
    }
    if (has(P.cpPhase) || has(P.berserk)) return { kind: "enemyPhase", ps };
    if (has(P.mapMain)) return { kind: "busy", ps };
    return { kind: "other", ps };
  }

  // ---- Button helpers (generators; yield = frames to wait) ---------------------------
  *press(key, hold = 2, after = 4) {
    this.ws.setKey(key, true); yield hold; this.ws.setKey(key, false); yield after;
  }
  *moveCursor(x, y, kind) {
    for (let n = 0; n < 80; n++) {
      const c = this.cursor();
      if (c.x === x && c.y === y) return true;
      const dir = c.x < x ? "RIGHT" : c.x > x ? "LEFT" : c.y < y ? "DOWN" : "UP";
      yield* this.press(dir, 2, 2);
      // wait for the cursor to register the move (it glides between tiles)
      for (let k = 0; k < 12; k++) { const d = this.cursor(); if (d.x !== c.x || d.y !== c.y) break; yield 1; }
      if (this.scene().kind !== kind) return false;
    }
    return false;
  }
  *waitFor(pred, maxFrames) {
    for (let f = 0; f < maxFrames; f += 2) { if (pred()) return true; yield 2; }
    return false;
  }

  *unstick() {
    for (let i = 0; i < 4; i++) yield* this.press("B", 2, 10);
    this.lastProgress = this.ws.frame; this.stuck = false;
  }

  // ---- Main loop ----------------------------------------------------------------------
  *main() {
    let otherCount = 0;
    for (;;) {
      const sc = this.scene();
      if (sc.kind !== this.sceneKind) { this.sceneKind = sc.kind; this.lastSceneChange = this.ws.frame; }
      switch (sc.kind) {
        case "free":
          if (this.phase() === 0) yield* this.playerFree();
          else yield 2;
          break;
        case "moveSelect": yield* this.onMoveSelect(); break;
        case "menu": yield* this.onMenu(sc.proc); break;
        case "target": yield* this.onTarget(sc.proc); break;
        case "difficulty": {
          const cur = this.r8(sc.proc.addr + 0x30);
          this.say("Choosing the difficulty");
          yield* this.press(cur < this.difficulty ? "DOWN" : cur > this.difficulty ? "UP" : "A", 2, 16);
          break;
        }
        case "worldmap": yield* this.onWorldMap(); break;
        case "tutorial": this.say("Following the tutorial"); this.intent = null; yield* this.press("A", 2, 20); break;
        case "shop": yield* this.onShop(sc.proc); break;
        case "trade": yield* this.onTrade(sc.proc); break;
        case "promoChoice": yield* this.onPromoChoice(sc.proc); break;
        case "classChoice": this.say("Choosing a class (first option)"); yield* this.press("A", 2, 30); break;
        case "supply": yield* this.onSupply(sc.proc); break;
        case "prep":
          // Pick the team by unit score first (once per chapter), then Start = "Fight!".
          if (!this.prepDone || this.prepDone !== this.chapter()) { if (this.prepItemsDone !== this.chapter()) { this.prepItemsDone = this.chapter(); yield* this.prepItems(); } yield* this.pickTeam(); this.prepDone = this.chapter(); }
          this.say("Battle preparations: starting the chapter");
          // Start means "Fight!" on the main screens; if a sub-screen eats it, back out once and retry.
          yield* this.press("START", 2, 90);
          if (this.scene().kind === "prep") { yield* this.press("B", 2, 30); yield* this.press("START", 2, 90); }
          break;
        case "wmMenu": this.say("Closing the world map menu"); yield* this.press("B", 2, 16); break;
        case "choice": this.say("Answering a question"); yield* this.press("A", 2, 20); break;
        case "event":
          // A map cutscene: Start skips the whole scene; A clears any text box left over.
          this.say("Skipping a cutscene");
          if (this.ws.frame - this.lastSceneChange < 8) { yield 2; break; } // let it settle first
          // During the enemy's turn a scene with no text is the game moving its own units around (Last
          // Hope's enemy phases): leave it alone. Pressing A through it kept that phase from ever ending.
          if (!sc.talking && this.phase() !== 0) { yield 10; break; }
          yield* this.press(sc.talking ? "START" : "A", 2, 14);
          break;
        case "dialogue": this.say("Reading text"); yield* this.press("A", 2, 12); break;
        case "popup": yield* this.press("A", 2, 16); break;
        case "battle":
          this.say(this.phase() === 0 && this.intent && this.intent.text ? this.intent.text : "Battle");
          if (sc.talking) yield* this.press("A", 2, 12); else yield 6; // battle quotes and level-ups
          break;
        case "enemyPhase": this.intent = null; this.say(this.phase() === 0x80 ? "Enemy phase" : "Other army's phase"); yield 6; break;
        case "busy": yield 3; break;
        default:
          // Title screen, file select, chapter intros: press A, then Start now and then.
          // Not during the enemy's turn: there the game runs itself, and pressing A and Start through it
          // kept Last Hope's enemy phase going round forever (with rewind protection on).
          if (this.phase() === 0x80 || this.phase() === 0x40) { yield 10; break; }
          otherCount++;
          this.say("Moving through menus");
          yield* this.press(otherCount % 4 === 0 ? "START" : "A", 2, 24);
      }
    }
  }

  *playerFree() {
    // Tell the page a new turn is starting before anyone moves, so its rewind point is taken from a
    // clean start of the turn. Before, at high speed the first snapshot could land after the first
    // (hurt, so urgent) unit had already moved: every retry of that turn started with Eirika's move
    // already made, so no retry could save her.
    const tk = `${this.chapter()}:${this.turn()}`;
    if (this._turnHook !== tk) { this._turnHook = tk; if (this.onTurnStart) this.onTurnStart(); }
    const units = this.units();
    const mine = units.filter((u) => u.side === "blue");
    // Free to act: not done, not being carried (US_RESCUED), on the map, and not a unit the game
    // has refused to select twice this turn (Kyle being carried by Garcia kept "acting" and the
    // turn ran out before Ross could move).
    this.selectFails = this.selectFails || new Map();
    const ready = mine.filter((u) => !(u.state & US_UNSELECTABLE) && !(u.state & 0x20) && u.x >= 0 && !this.cannotAct(u) &&
      (this.selectFails.get(`${this.turn()}:${u.addr}`) || 0) < 2);
    if (this.intent && this.intent.stage === "done") {
      this.menuTries = new Map(); // that action went through
      if (this.onAction) this.onAction(this.intent);
      this.intent = null;
    }
    if (!ready.length) { yield* this.endTurn(units); return; }
    // Badly hurt units act first, while there is still room to get them to safety (Ross at 8 HP
    // was left for last and the turn ran out).
    const urgent = ready.filter((u) => u.hp * 2 < u.maxHP);
    let plan = this.plan(units, urgent.length ? urgent : ready);
    if (!plan && urgent.length) plan = this.plan(units, ready);
    if (!plan) {
      // Every square has been ruled out (failed before this turn): forget those and try again.
      this.failedSquares = new Set();
      plan = this.plan(units, ready);
      if (!plan) { yield* this.endTurn(units); return; }
    }
    this.intent = { ...plan, stage: "select" };
    this.moveLog = this.moveLog || new Map();
    if (plan.unit && plan.dest) this.moveLog.set(`${this.chapter()}:${this.turn()}:${plan.unit.charId}`, `${plan.dest.x},${plan.dest.y}`);
    this.say(plan.text);
    const u = plan.unit;
    const fk = `${this.turn()}:${u.addr}`;
    if (!(yield* this.moveCursor(u.x, u.y, "free"))) { this.selectFails.set(fk, (this.selectFails.get(fk) || 0) + 1); return; }
    yield* this.press("A", 2, 6);
    const ok = yield* this.waitFor(() => { const k = this.scene().kind; return k === "moveSelect" || k === "menu"; }, 60);
    if (ok) this.intent.stage = "move";
    else this.selectFails.set(fk, (this.selectFails.get(fk) || 0) + 1);
  }

  // ---- Battle preparations: choose who to deploy --------------------------------------
  // The "Pick Units" screen is a proc with cur_counter (+0x29) / max_counter (+0x2A) and the
  // cursor row at +0x2E; the rows come from gPrepUnitList (64 unit pointers in EWRAM), found by
  // scanning for a run of player-unit pointers.
  // The "Pick Units" screen: ProcScr_PrepUnitScreen at 0x08A18E8C (found from its sub_809B2DC step);
  // +0x29 deployed count, +0x2A deploy limit, +0x2E cursor row. Rows are gPrepUnitList (0x020121CC).
  findPrepPicker() {
    const p = this.procs().find((q) => q.script === 0x08A18E8C);
    return p ? p.addr : 0;
  }
  findPrepList() {
    // gPrepUnitList: its address is the one the preparations code refers to (six times).
    const [base, n] = this.g.units.blue, lo = base, hi = base + n * 0x48, addr = 0x020121CC;
    let k = 0;
    while (k < 64) { const v = this.r32(addr + k * 4); if (!(v >= lo && v < hi && (v - lo) % 0x48 === 0)) break; k++; }
    return k ? { addr, count: k } : null;
  }
  *pickTeam() {
    // Open "Pick Units" first (the list it shows is built when it opens), then read it.
    let picker = this.findPrepPicker();
    if (!picker) {
      // Let the Preparations menu finish appearing; "Pick Units" is its first item. A conversation
      // can still be playing over the preparations (Chapter 14 opens that way) and each press only
      // turns its page, so keep pressing until the picker opens.
      for (let tries = 0; tries < 25 && !picker; tries++) {
        yield 90;
        yield* this.press("A", 4, 10);
        for (let k = 0; k < 40 && !(picker = this.findPrepPicker()); k++) yield 4;
      }
    }
    if (!picker) { this.say("Battle preparations: keeping the default team (Pick Units did not open)"); return; }
    for (let k = 0; k < 30 && this.r32(picker + 0x0C) !== 0x0809B039; k++) yield 4; // wait for its idle loop
    const list = this.findPrepList();
    if (!list) { this.say("Battle preparations: keeping the default team (no unit list)"); yield* this.press("B", 2, 30); return; }
    const max = this.r8(picker + 0x2A);
    const rows = [];
    for (let i = 0; i < list.count; i++) { const a = this.r32(list.addr + i * 4); rows.push(this.readUnit(a, "blue")); }
    // On this screen every unit is flagged hidden (deployed ones read 1, benched ones 0x20000b), so
    // that flag says nothing; only a unit that is missing or flagged 0x10000 is treated as unavailable.
    const away = (u) => !u || (this.r32(u.addr + 0x0C) & 0x10000) !== 0;
    const scores = this.armyScores(rows);
    // Lords are always deployed by the game; then Seth; then the best scores.
    const want = new Set(rows.filter((u) => !away(u) && this.g.lordIds.includes(u.charId)).map((u) => u.charId));
    if (rows.some((u) => u.charId === 0x02)) want.add(0x02);
    // A map with locked doors (Chapter 13 is all corridors and doors) needs someone who can open
    // them: bring a thief (lockpick) and anyone carrying a Door Key.
    let hasDoors = false;
    try { const mp = this.map(); for (let y = 0; y < mp.h && !hasDoors; y++) for (let x = 0; x < mp.w; x++) if (mp.t[y][x] === this.g.terrain.door) { hasDoors = true; break; } } catch (e) { /* map not ready */ }
    if (hasDoors) {
      const opener = (u) => u.items.some((i) => i.id === this.g.items.doorKey || i.id === this.g.items.lockpick) ||
        /Thief|Rogue|Assassin/.test(this.text(this.r16(u.classPtr)));
      for (const u of rows.filter((u) => !away(u) && opener(u)).slice(0, 2)) want.add(u.charId);
      if (rows.some(opener)) this.say("Doors on this map: bringing someone who can open them");
    }
    // Always bring healers (up to two) - without them the army wears down over a long chapter.
    // Healers who still hold a heal staff come first (in Hamill Canyon the two picked had none, while
    // L'Arachel with her Mend sat on the bench); staffless ones only fill in after them.
    const holds = (u) => u.items.some((i) => this.g.healStaves[i.id]) ? 1 : 0;
    const healers = rows.filter((u) => !away(u) && u.ranks[4] > 0)
      .sort((a, b) => holds(b) - holds(a) || scores.get(b.charId) - scores.get(a.charId));
    for (const h of healers.slice(0, 2)) if (want.size < max) want.add(h.charId);
    // A Dancer always gets a slot (she cannot promote, so the "still below level 10" rule does not apply).
    for (const d of rows.filter((u) => !away(u) && /Dancer|Bard/.test(this.text(this.r16(u.classPtr)))).slice(0, 1)) if (want.size < max) want.add(d.charId);
    // Fill the rest by score, but not with someone who has nothing to fight or heal with (Artur's
    // tome had worn out; he was deployed anyway and kept dying unarmed in Hamill Canyon).
    const convoyIds = (() => { try { return this.convoyItems().map((i) => i.id || i); } catch (e) { return []; } })();
    const useful = (u) => this.weaponsOf(u).length > 0 || holds(u) || this.bestBuy(u, convoyIds, 1e9) >= 0 || /Dancer|Bard/.test(this.text(this.r16(u.classPtr))); // a Dancer gives another unit a second action
    // Pegasus knights sit out maps full of archers (bows hit fliers for three times the might): in Last
    // Hope Tana and Vanessa died to archers on most retries. Counted from the enemies on this map.
    let bowmen = 0;
    try { const [rb, rn] = this.g.units.red; for (let i = 0; i < rn; i++) { const a = rb + i * 0x48; if (!this.r32(a)) continue; const e = this.readUnit(a, "red"); if (e && e.items.some((it) => this.item(it.id).type === 3)) bowmen++; } } catch (e) { /* map not ready */ }
    // Wyvern riders stay in (Casim: keep Cormag on the map, just never where a second archer can reach
    // him; the flier rule in danger() handles that).
    const pegasus = (u) => /Pegasus|Falco/.test(this.text(this.r16(u.classPtr)));
    const sitOut = (u) => bowmen >= 4 && pegasus(u) && !want.has(u.charId);
    if (bowmen >= 4) this.say(`${bowmen} archers on this map: Pegasus Knights stay out`);
    // On a Survive map the rest of the team is the sturdy ones first: frail healers beyond the two picked
    // above kept dying in Last Hope (Natasha, Moulder) while Gilliam and Garcia sat on the bench.
    // (The objective is not readable yet on the preparations screen, so Last Hope is also named.)
    const surviveNext = this.goalType() === 2 || this.chapterTitle(this.chapter()) === "Last Hope";
    const sturdy = (u) => surviveNext ? (u.maxHP >= 25 && u.def >= 6 ? 1 : 0) : 0;
    // On a Survive map the other twin stays out when this is Eirika's route: his death would also lose it.
    // (Tried: leaving Ephraim out on Eirika's Survive maps, since his death also loses. In Last Hope the
    // team was weaker for it and ordinary units died instead; lord deaths were rare. He plays again.)
    this._benchEph = false;
    if (this._benchEph) want.delete(0x0F);
    // On a Survive map rank by how hard the unit is to kill (Casim: field high Def/Res or high Spd/Lck
    // units): HP, Defence and Resistance, plus Speed and Luck for dodging and avoiding crits.
    // A Manakete's stats are read in human form; her Dragonstone raises them a lot when she fights
    // (Casim: Myrrh is very good even at base), so a usable stone counts for much more.
    const stone = (u) => u.items.some((i) => this.text(this.r16(this.g.itemData + i.id * this.g.itemSize)) === "Dragonstone" && i.uses > 0) ? 45 : 0;
    const surv = (u) => u.maxHP + 1.5 * u.def + 1.2 * u.res + 0.8 * u.spd + 0.5 * (u.lck || 0) + stone(u) - (this.lowPriority(u.charId) ? 30 : 0);
    // An unpromoted unit still below level 10 this late (from Chapter 15 on) is far behind the enemy
    // and goes last, whatever its class (Gilliam, a level-5 Knight in Last Hope, died to one Fighter).
    const behind = (u) => this.chapter() >= 15 && !(this.r32(u.classPtr + 0x28) & 0x100) && this.r8(u.addr + 8) < 10 ? 1 : 0;
    // Units close to S rank in a weapon type whose S-rank legendary the army holds (Innes: bows for
    // Nidhogg, Gerik: axes for Garm) go out first on ordinary maps, to reach S before Lyon and the final
    // map (Casim's call). Not on Survive maps, where only staying alive counts.
    const sTypes = new Set();
    try {
      const held = [...this.convoyItems().map((i) => i.id || i)];
      for (const r of rows) for (const it of r.items) held.push(it.id);
      for (const id of held) { const d = this.item(id); if (d.rank >= 251 && d.type <= 7) sTypes.add(d.type); }
    } catch (e) { /* convoy not readable */ }
    const trainee = (u) => !surviveNext && [...sTypes].some((t) => u.ranks[t] >= 211 && u.ranks[t] < 251) ? 1 : 0; // within 40 weapon experience of S
    for (const u of [...rows].filter((u) => !away(u) && !sitOut(u) && !(this._benchEph && surviveNext && u.charId === 0x0F)).sort((a, b) => (useful(b) - useful(a)) || (behind(a) - behind(b)) || (trainee(b) - trainee(a)) || (surviveNext ? surv(b) - surv(a) : (sturdy(b) - sturdy(a)) || scores.get(b.charId) - scores.get(a.charId)))) { if (want.size >= max) break; want.add(u.charId); }
    this.say(`Picking the team: ${[...want].map((id) => this.charName(id)).join(", ")}`);
    this.say(`(list states: ${rows.map((u) => u ? `${this.charName(u.charId)} ${this.r32(u.addr + 0x0C).toString(16)}` : "?").join(", ")})`);
    const deployed = (i) => !(this.r32(this.r32(list.addr + i * 4) + 0x0C) & US_NOT_DEPLOYED);
    // The list is two columns: Down/Up move two places, Right/Left move one.
    const goRow = function* (bot, i) {
      for (let k = 0; k < 70; k++) {
        const c = bot.r16(picker + 0x2E), d = i - c;
        if (!d) return;
        yield* bot.press(d >= 2 ? "DOWN" : d <= -2 ? "UP" : d > 0 ? "RIGHT" : "LEFT", 2, 6);
      }
    };
    // First take out anyone not wanted, then put in the wanted ones. Then check what actually got
    // deployed and go again (twice at most): the list said L'Arachel was picked for Hamill Canyon,
    // but she stayed on the bench and an unarmed Artur went in.
    for (let round = 0; round < 3; round++) {
      for (const pass of [false, true]) {
        for (let i = 0; i < rows.length; i++) {
          const isWanted = want.has(rows[i].charId);
          if (deployed(i) === isWanted || isWanted !== pass) continue;
          yield* goRow(this, i);
          if (this.r16(picker + 0x2E) !== i) continue;
          yield* this.press("A", 2, 14);
        }
      }
      const wrong = rows.filter((r, i) => deployed(i) !== want.has(r.charId));
      if (!wrong.length) break;
      this.say(`Team pick round ${round + 1}: still wrong for ${wrong.map((r) => this.charName(r.charId)).join(", ")}`);
    }
    this.say(`Deployed: ${rows.filter((r, i) => deployed(i)).map((r) => this.charName(r.charId)).join(", ")}`);
    yield* this.press("B", 2, 40); // back to the preparations menu
  }

  // Trade screen: column 0 = the acting unit, column 1 = the partner; hover column +0x41, row +0x42.
  // Pick up the partner's weapon, drop it on our first empty row, then leave.
  *onTrade(proc) {
    const p = proc.addr, it = this.intent, idle = this.r32(p + 0x0C);
    const col = () => this.r8(p + 0x41), row = () => this.r8(p + 0x42);
    const go = function* (bot, c, r) {
      for (let k = 0; k < 20 && (col() !== c || row() !== r); k++) {
        if (col() !== c) yield* bot.press(col() < c ? "RIGHT" : "LEFT", 2, 8);
        else yield* bot.press(row() < r ? "DOWN" : "UP", 2, 8);
      }
    };
    if (!it || it.kind !== "trade" || it.traded) { yield* this.press("B", 2, 20); return; }
    if (idle === this.g.idle.tradeIdle) {
      if (it.picked) { // done: leave the screen, and write down what each side now holds (staves went missing before)
        it.traded = true;
        const a = this.readUnit(it.unit.addr, "blue"), t = it.target && this.readUnit(it.target.addr, "blue");
        if (a) this.say(`(after the trade ${this.uname(a)} holds ${a.items.map((i) => this.text(this.r16(this.g.itemData + i.id * this.g.itemSize))).join(", ") || "nothing"}${t ? `; ${this.uname(t)} holds ${t.items.map((i) => this.text(this.r16(this.g.itemData + i.id * this.g.itemSize))).join(", ") || "nothing"}` : ""})`);
        yield* this.press("B", 2, 20); return;
      }
      yield* go(this, 1, it.partnerSlot);
      yield* this.press("A", 2, 12);
      it.picked = true;
      return;
    }
    // Holding the partner's weapon: put it on our first empty row.
    yield* go(this, 0, Math.min(4, it.unitItems));
    yield* this.press("A", 2, 16);
  }

  // "a Steel Lance" / "an Iron Axe".
  aOrAn(name) { return (/^[AEIOU]/i.test(name || "") ? "an " : "a ") + (name || "item"); }
  // Choosing a class on promotion (Casim's rule): look at how the unit has actually grown so far,
  // find the stats it grows best in (above its own average), and pick the class whose promotion
  // bonuses add most to those stats.
  classByName(name) {
    const any = this.units().find((u) => u.side === "blue");
    if (!any) return 0;
    const base = any.classPtr - this.r8(any.classPtr + 4) * 0x54;
    for (let i = 1; i < 0x80; i++) { const c = base + i * 0x54; if (this.text(this.r16(c)) === name) return c; }
    return 0;
  }
  *onPromoChoice(proc) {
    const menu = proc.addr, m = this.menuItems(menu);
    if (m.n < 1 || m.n > 6) { yield 6; return; }
    if (this.promoPicked === menu) { yield* this.press("A", 2, 20); return; } // confirm "change class?"
    let names = m.items.map((i) => this.text(i.msg));
    // Who is promoting: the unit whose class leads to these options; take the blue unit at level 10+
    // that is not promoted and whose growth we can read (trainees reach this at level 10).
    const cands = this.units().filter((u) => u.side === "blue" && !(this.r32(u.classPtr + 0x28) & 0x100));
    // The unit using the item is the one we sent to promote (picking the highest-level candidate chose
    // Forde's class for Franz's promotion).
    const mine = this.intent && this.intent.kind === "promote" && this.intent.unit && this.readUnit(this.intent.unit.addr, "blue");
    const u = mine || cands.sort((a, b) => this.r8(b.addr + 8) - this.r8(a.addr + 8))[0];
    let pick = 0;
    // This screen's menu has no readable class names (the bot saw blanks and "Change" and always took
    // the first option), so take the two choices from the game's promotion table instead: two class
    // ids per class, in the order the menu lists them.
    if (u && !names.some((n) => n && n.trim()) ) { // only the class list itself comes back blank; the "Change?" confirm keeps its first option
      const base = u.classPtr - this.r8(u.classPtr + 4) * 0x54, cid = this.r8(u.classPtr + 4);
      const opts = [this.r8(0x0895DFA4 + cid * 2), this.r8(0x0895DFA4 + cid * 2 + 1)].filter((id) => id);
      if (opts.length) names = opts.map((id) => this.text(this.r16(base + id * 0x54)));
    }
    if (u) {
      const now = [u.maxHP, u.pow, u.skl, u.spd, u.def, u.res];
      const cb = [0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11].map((o) => this.s8(u.charPtr + o));
      const kb = [0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10].map((o) => this.s8(u.classPtr + o));
      const lv = Math.max(1, this.r8(u.addr + 8) - this.r8(u.charPtr + 0x0B));
      const rate = now.map((v, i) => Math.max(0, v - cb[i] - kb[i]) / lv);
      const avg = rate.reduce((a, b) => a + b, 0) / rate.length;
      const weight = rate.map((r, i) => (i === 0 ? 0.5 : 1) * (0.25 + Math.max(0, r - avg) * 4)); // HP counts half
      let best = -1;
      names.forEach((nm, i) => {
        const c = this.classByName(nm); if (!c) return;
        // promotion bonuses (+0x22.. HP, Str, Skl, Spd, Def, Res) plus the new class's higher bases
        const gain = [0x22, 0x23, 0x24, 0x25, 0x26, 0x27].map((o, k) => this.s8(c + o) + Math.max(0, this.s8(c + 0x0B + k) - kb[k]) * 0.5);
        const sc = gain.reduce((a, g, k) => a + g * weight[k], 0);
        if (sc > best) { best = sc; pick = i; }
      });
      this.say(`${this.uname(u)} promotes to ${names[pick]} (best fit for how they have grown)`);
    }
    this.promoPicked = menu;
    yield* this.pickMenu(menu, pick);
  }

  // Convoy items, as a list of item ids.
  convoyItems() {
    const out = [];
    for (let i = 0; i < 100; i++) { const v = this.r16(0x0203A81C + i * 2); if (!v) break; out.push(v & 0xFF); }
    return out;
  }
  // Supply screen: Take a weapon this unit can use from the convoy. The convoy list for the current
  // page is gPrepScreenItemList (0x020122D4, 4-byte entries: pid, slot, item) with its count at
  // 0x02012F56; the page is +0x35 and its cursor row is idxPerPage[page] at +0x3A.
  *onSupply(proc) {
    // Give/Take box: +0x33 is 0 for Give, 1 for Take (Up/Down switch). If the unit's hands are
    // full, first Give something it cannot use to the convoy, then Take a weapon.
    const p = proc.addr, it = this.intent, idle = this.r32(p + 0x0C);
    const u = this.readUnit(this.r32(p + 0x2C), "blue");
    if (it.supplied || (it.supplyTries || 0) > 12) { yield* this.press("B", 2, 20); return; }
    // Preparations: "give" puts every weapon the unit cannot use into the convoy; "take" takes the best
    // weapon it can use (legendaries count most, by might).
    if (it.mode && idle === this.g.idle.supplyGiveTake) {
      it.supplyTries = (it.supplyTries || 0) + 1;
      const want = it.mode === "give" ? (this.giveSlot(u) >= 0 ? 0 : -1) : (u.items.length < 5 ? 1 : -1);
      if (want < 0) { it.supplied = true; yield* this.press("B", 2, 20); return; }
      for (let k = 0; k < 4 && this.r8(p + 0x33) !== want; k++) yield* this.press("DOWN", 2, 8);
      yield* this.press("A", 2, 20);
      return;
    }
    if (it.mode === "give" && idle === this.g.idle.supplyUnitInv) {
      const g = this.giveSlot(u);
      if (g < 0) { yield* this.press("B", 2, 16); return; }
      for (let k = 0; k < 8 && this.r8(p + 0x31) !== g; k++) yield* this.press(this.r8(p + 0x31) < g ? "DOWN" : "UP", 2, 6);
      this.say(`${this.uname(u)} puts ${this.aOrAn(this.text(this.r16(this.g.itemData + u.items.find((i) => i.slot === g).id * this.g.itemSize)))} in the convoy`);
      yield* this.press("A", 2, 20);
      return;
    }
    if (idle === this.g.idle.supplyGiveTake) {
      it.supplyTries = (it.supplyTries || 0) + 1;
      const full = u.items.length >= 5, junk = this.junkSlot(u);
      if (full && junk < 0) { it.supplied = true; yield* this.press("B", 2, 20); return; }
      const want = full ? 0 : 1;
      for (let k = 0; k < 4 && this.r8(p + 0x33) !== want; k++) yield* this.press("DOWN", 2, 8);
      yield* this.press("A", 2, 20);
      return;
    }
    if (idle === this.g.idle.supplyUnitInv) {
      // Giving: put the junk item into the convoy, then go back to the Give/Take box.
      const junk = this.junkSlot(u);
      if (junk < 0 || it.gave) { yield* this.press("B", 2, 16); return; }
      for (let k = 0; k < 8 && this.r8(p + 0x31) !== junk; k++) yield* this.press(this.r8(p + 0x31) < junk ? "DOWN" : "UP", 2, 6);
      this.say(`${this.uname(u)} puts ${this.aOrAn(this.text(this.r16(this.g.itemData + u.items.find((i) => i.slot === junk).id * this.g.itemSize)))} in the convoy`);
      yield* this.press("A", 2, 20);
      it.gave = true;
      return;
    }
    if (idle !== this.g.idle.supplyList) { yield 4; return; }
    const n = this.r16(0x02012F56), page = this.r8(p + 0x35);
    const ids = []; for (let i = 0; i < n && i < 100; i++) ids.push(this.r16(0x020122D4 + i * 4 + 2) & 0xFF);
    const pick = this.bestBuy(u, ids, 1e9); // best usable weapon on this page (price ignored)
    if (pick < 0) {
      it.pages = (it.pages || 0) + 1;
      if (it.pages > 9) { it.supplied = true; yield* this.press("B", 2, 16); return; }
      yield* this.press("RIGHT", 2, 20); // next weapon type
      return;
    }
    const cur = () => this.r16(p + 0x3A + page * 2);
    for (let k = 0; k < 40 && cur() !== pick; k++) yield* this.press(cur() < pick ? "DOWN" : "UP", 2, 6);
    this.say(`${this.uname(u)} takes ${this.aOrAn(this.text(this.r16(this.g.itemData + ids[pick] * this.g.itemSize)))} from the convoy`);
    yield* this.press("A", 2, 20);
    it.supplied = true;
  }

  // Price of an item = cost per use x uses.
  price(id) { const a = this.g.itemData + id * this.g.itemSize; return this.r16(a + 0x1A) * this.r8(a + 0x14); }
  // Best weapon this unit can use and afford from a list of item ids; returns its index.
  bestBuy(u, ids, gold) {
    let best = -1, bs = -1;
    // A healer without a staff buys the strongest heal staff it can use; a unit without a potion, a Vulnerary.
    if (u.ranks[4] > 0 && !u.items.some((i) => this.g.healStaves[i.id])) {
      ids.forEach((id, i) => {
        const amt = this.g.healStaves[id], d = this.item(id);
        if (!amt || (d.rank && u.ranks[4] < d.rank) || this.price(id) > gold) return;
        if (amt > bs) { bs = amt; best = i; }
      });
      if (best >= 0) return best;
    }
    if (!u.items.some((i) => i.id === this.g.vulnerary || i.id === 0x6D)) {
      const i = ids.indexOf(this.g.vulnerary);
      if (i >= 0 && this.price(ids[i]) <= gold && (this.intent && this.intent.kind === "vendor")) return i;
    }
    ids.forEach((id, i) => {
      const d = this.item(id);
      if (!(d.attr & 1) || d.type > 7 || d.type === 4) return;          // weapons only
      if (!u.ranks[d.type] || (d.rank && u.ranks[d.type] < d.rank)) return;
      const p = this.price(id); if (p > gold) return;
      const sc = d.might * 10 + d.hit - p / 500 + (d.min > 1 ? -5 : 0); // strong, accurate, not too dear
      if (sc > bs) { bs = sc; best = i; }
    });
    return best;
  }
  *onShop(proc) {
    const p = proc.addr, idle = this.r32(p + 0x0C), it = this.intent;
    if (!this.shopVisit || this.shopVisit.addr !== p) this.shopVisit = { addr: p, gold: this.r32(this.g.gold), bought: false, tries: 0 };
    const v = this.shopVisit;
    if (this.r32(this.g.gold) < v.gold) v.bought = true;
    if (idle === this.g.idle.shopBuyList) {
      if (v.bought || v.tries > 3) { this.say("Leaving the armory"); yield* this.press("B", 2, 20); return; }
      const ua = this.r32(p + 0x2C), u = ua ? this.readUnit(ua, "blue") : null;
      const n = this.r8(p + 0x5A), ids = [];
      for (let i = 0; i < n && i < 20; i++) ids.push(this.r16(p + 0x30 + i * 2) & 0xFF);
      const pick = u ? this.bestBuy(u, ids, this.r32(this.g.gold)) : -1;
      if (pick < 0) { v.tries = 9; yield* this.press("B", 2, 20); return; }
      this.say(`${u ? this.uname(u) : "A unit"} buys ${this.aOrAn(this.text(this.r16(this.g.itemData + ids[pick] * this.g.itemSize)))}`);
      const sel = () => this.r8(p + 0x5C) + this.r8(p + 0x5D); // first visible row + cursor row
      for (let k = 0; k < 24 && sel() !== pick; k++) yield* this.press(sel() < pick ? "DOWN" : "UP", 2, 6);
      v.tries++;
      yield* this.press("A", 2, 20);
      return;
    }
    if (idle === this.g.idle.shopEntry) {
      // The Buy / Sell / leave prompt: buy once, then leave.
      yield* this.press(v.bought || v.tries > 3 ? "B" : "A", 2, 20);
      return;
    }
    // Shopkeeper's lines and "buy it?" prompts: A to go ahead; once the weapon is bought, B to leave.
    yield* this.press(v.bought || v.tries > 3 ? "B" : "A", 2, 14);
    if (it) it.stage = "done";
  }

  // On the world map, the next chapter's location carries a flag. Put the cursor on it and press A.
  wmTarget() {
    const ch = this.chapter();
    for (let i = 0; i < this.g.wmNodeCount; i++) {
      const n = this.g.wmNodes + i * 0x20;
      if (this.r8(n + 4) === ch || this.r8(n + 5) === ch) return { x: this.s16(n + 0x18), y: this.s16(n + 0x1A), name: this.text(this.r16(n + 0x1C)) };
    }
    return null;
  }
  *onWorldMap() {
    const t = this.wmTarget();
    const cur = () => ({ x: this.r32(this.g.gmData + 8) >> 8, y: this.r32(this.g.gmData + 12) >> 8 });
    if (!t) { this.say("On the world map, looking for the next chapter"); yield* this.press("L", 2, 30); return; }
    this.say(`Travelling to ${t.name || "the next chapter"}`);
    // L jumps the cursor from location to location; try that first.
    for (let i = 0; i < 12; i++) {
      const c = cur();
      if (c.x === t.x && c.y === t.y) break;
      yield* this.press("L", 2, 20);
      if (this.scene().kind !== "worldmap") return;
    }
    const c = cur();
    if (c.x !== t.x || c.y !== t.y) {
      // Fall back to steering the cursor by hand.
      for (let k = 0; k < 120; k++) {
        const d = cur(); if (Math.abs(d.x - t.x) <= 2 && Math.abs(d.y - t.y) <= 2) break;
        const dir = Math.abs(d.x - t.x) > 2 ? (d.x < t.x ? "RIGHT" : "LEFT") : (d.y < t.y ? "DOWN" : "UP");
        yield* this.press(dir, 4, 1);
      }
    }
    yield* this.press("A", 2, 40);
  }

  *endTurn(units) {
    this.say("Ending the turn");
    // Open the map menu by pressing A on an empty tile, then pick End.
    const m = this.map(), taken = new Set(units.map((u) => u.x + "," + u.y));
    const c = this.cursor();
    let best = null, bd = 1e9;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (taken.has(x + "," + y)) continue;
      const d = Math.abs(x - c.x) + Math.abs(y - c.y);
      if (d < bd) { bd = d; best = { x, y }; }
    }
    this.intent = { kind: "end", stage: "menu", text: "Ending the turn" };
    if (best) yield* this.moveCursor(best.x, best.y, "free");
    yield* this.press("A", 2, 8);
    yield* this.waitFor(() => this.scene().kind !== "free", 40);
  }

  *onMoveSelect() {
    const it = this.intent;
    const au = this.r32(this.g.activeUnit);
    if (it && it.stage === "move" && it.unit && au === it.unit.addr) {
      this.say(it.text);
      // Check the plan against the game's own movement map (it knows about weather and anything hidden).
      const w = this.s16(this.g.mapSize), h = this.s16(this.g.mapSize + 2);
      const mv = (x, y) => this.r8(this.r32(this.r32(this.g.mapMovement) + y * 4) + x);
      const occ = (x, y) => this.r8(this.r32(this.r32(this.g.mapUnit) + y * 4) + x);
      const okTile = (x, y) => mv(x, y) <= it.unit.mov && (!occ(x, y) || (x === it.unit.x && y === it.unit.y));
      if (!okTile(it.dest.x, it.dest.y)) {
        let bestT = { x: it.unit.x, y: it.unit.y }, bd = 1e9;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (!okTile(x, y)) continue;
          const d = Math.abs(x - it.dest.x) + Math.abs(y - it.dest.y);
          if (d < bd) { bd = d; bestT = { x, y }; }
        }
        it.dest = bestT;
        if (it.kind !== "move" && it.kind !== "wait") { it.kind = "move"; it.text = `${this.uname(it.unit)} moves as close as it can`; }
      }
      if (!(yield* this.moveCursor(it.dest.x, it.dest.y, "moveSelect"))) return;
      yield* this.press("A", 2, 6);
      const ok = yield* this.waitFor(() => this.scene().kind === "menu", 240);
      if (ok) it.stage = "act";
      else {
        // The game refused the square (something we cannot see is there). Never pick it again this turn.
        this.say("Could not move there, choosing again");
        { const fk2 = `${this.turn()}:${it.unit.addr}`; this.selectFails.set(fk2, (this.selectFails.get(fk2) || 0) + 1); }
        this.badTiles = this.badTiles || new Set();
        this.badTiles.add(`${this.turn()}:${it.unit.addr}:${it.dest.x},${it.dest.y}`);
        yield* this.press("B", 2, 10); this.intent = null;
      }
      return;
    }
    // Not ours: either Canto (move again after acting) or a stray selection. Stay put.
    const u = au ? this.readUnit(au, "blue") : null;
    if (u) { yield* this.moveCursor(u.x, u.y, "moveSelect"); yield* this.press("A", 2, 10); }
    else yield* this.press("B", 2, 10);
    this.intent = { kind: "wait", stage: "act", text: "Waiting" };
  }

  menuItems(menu) {
    const n = this.r8(menu + 0x60), cur = this.r8(menu + 0x61), items = [];
    for (let i = 0; i < n && i < 11; i++) {
      const ip = this.r32(menu + 0x34 + i * 4);
      const def = ip ? this.r32(ip + 0x30) : 0;
      items.push({ msg: def ? this.r16(def + 4) : 0, number: ip ? this.s8(ip + 0x3C) : i });
    }
    return { n, cur, items };
  }
  *pickMenu(menu, index) {
    for (let k = 0; k < 24; k++) {
      const { cur, n } = this.menuItems(menu);
      if (cur === index) break;
      const down = (index - cur + n) % n <= n / 2;
      yield* this.press(down ? "DOWN" : "UP", 2, 4);
    }
    yield* this.press("A", 2, 10);
  }

  *onMenu(proc) {
    const menu = proc.addr, m = this.menuItems(menu), msg = this.g.msg;
    // A menu is read the moment it opens; until the game has filled it in, its fields are junk.
    const def = this.r32(menu + 0x30);
    if (def < 0x08000000 || def >= 0x0A000000 || m.n < 1 || m.n > 11 || m.cur >= m.n || m.items.some((i) => i.msg === 0 && m.n > 1 && i.number < 0)) {
      yield 4; return;
    }
    const idx = (id) => m.items.findIndex((i) => i.msg === id);
    const it = this.intent;
    if (idx(msg.wait) >= 0) {               // the unit's action menu
      if (it && it.stage === "move") {
        // The menu opened before the unit moved (it happens on the first selection of a map).
        yield* this.press("B", 2, 12); this.intent = null; return;
      }
      // Took a healing item from a teammate: back on the menu, drink it straight away.
      if (it && it.kind === "trade" && it.healAfter && it.traded && !it.healed) {
        it.healed = true; it.kind = "heal"; it.slot = it.unitItems; it.stage = "act";
        this.say(`${this.uname(it.unit)} drinks it`);
      }
      if (it && (it.stage === "weapon" || it.stage === "target")) {
        // The next screen can take a moment to open; only call it a failure if we are still here.
        if (!it.backSince) it.backSince = this.ws.frame;
        if (this.ws.frame - it.backSince < 45) { yield 5; return; }
        // We already chose an action here and are back on the menu: it could not go through
        // (for example a ballista with no ammo shows a Help box). Close the box, never use this
        // square for that unit again this chapter, and wait.
        this.say(`${it.text} could not go through, waiting instead`);
        yield* this.press("B", 2, 12);
        this.badTiles = this.badTiles || new Set();
        if (it.unit && it.dest) for (let t = this.turn(); t < this.turn() + 60; t++) this.badTiles.add(`${t}:${it.unit.addr}:${it.dest.x},${it.dest.y}`);
        this.intent = { kind: "wait", stage: "act", text: "Waiting", unit: it.unit };
        return;
      }
      if (!it || it.stage !== "act") {
        yield* this.pickMenu(menu, idx(msg.wait)); if (this.intent) this.intent.stage = "done"; return;
      }
      let want = msg.wait;
      if (it.kind === "promote") { this.promoTried.add(`${it.unit.charId}:${it.itemId}`); }
      if (it.kind === "rescue" && it.target) {
        this.rescueMarks = this.rescueMarks || new Set();
        this.rescueMarks.add(`${this.turn()}:${it.target.charId}`);
        if (idx(msg.rescue) < 0) this.rescueMarks.add(`no:${it.unit.charId}>${it.target.charId}`);
      }
      if (it.kind === "talk" && it.target) { this.talkTried = this.talkTried || new Set(); this.talkTried.add(`${this.chapter()}:${it.unit.charId}>${it.target.charId}`); }
      const wanted = { dance: msg.dance, supply: msg.supply, trade: msg.trade, rescue: msg.rescue, drop: msg.drop, promote: msg.item, shop: msg.armory, vendor: msg.vendor, seize: msg.seize, attack: msg.attack, staff: msg.staff, heal: msg.item, talk: msg.talk, door: msg.door, chest: msg.chest }[it.kind];
      if (it.kind === "door" && idx(msg.door) < 0 && idx(msg.pick) >= 0) want = msg.pick; // a Rogue opens doors with Pick, no key needed
      else if (idx(msg.seize) >= 0) want = msg.seize;                 // the lord reached the objective
      else if (wanted && idx(wanted) >= 0) want = wanted;
      else if (idx(msg.visit) >= 0) want = msg.visit;            // free village rewards
      else if (idx(msg.chest) >= 0) want = msg.chest;
      // If this exact choice already failed to go through (a ballista with no ammo shows "Attack"
      // but cannot fire), take Wait instead of looping.
      this.menuTries = this.menuTries || new Map();
      const mk = `${this.turn()}:${it.unit ? it.unit.charId : 0}:${want}`;
      const tries = (this.menuTries.get(mk) || 0) + 1; this.menuTries.set(mk, tries);
      if (tries > 2 && want !== msg.wait) { want = msg.wait; this.say(`${it.text} did not work, waiting instead`); }
      if (want === msg.wait && it.kind !== "wait" && it.kind !== "move") this.say(`${it.text} (not possible here, waiting)`);
      // An attack whose menu has no Attack: the weapon is locked to someone else (Forde was handed
      // Reginleif, Ephraim's own lance). Never count that weapon as his again.
      if (it.kind === "attack" && it.target && idx(msg.attack) < 0 && it.unit && it.weaponSlot !== undefined) {
        const w = it.unit.items.find((i) => i.slot === it.weaponSlot);
        if (w) { this.weaponBan = this.weaponBan || new Set(); this.weaponBan.add(`${it.unit.charId}:${w.id}`); }
      }
      // A lord whose menu has no Seize on the objective is not this chapter's seizer: remember that,
      // so they step off the square for the one who is (Ephraim cannot seize in Chapter 8; Eirika can).
      // A lord whose menu had no Seize steps aside for the other lord, but only for a couple of turns:
      // remembered for the whole chapter it left Eirika (the only lord in Chapter 3) unable to ever
      // seize, walking back and forth for 50 turns after the map was clear.
      if (it.kind === "seize" && want !== msg.seize && it.unit) { this.noSeize = this.noSeize || new Map(); this.noSeize.set(`${this.chapter()}:${it.unit.charId}`, this.turn()); }
      it.stage = want === msg.attack || want === msg.staff ? "weapon" : want === msg.item ? "itemList"
        : want === msg.talk || want === msg.door || want === msg.rescue || want === msg.drop || want === msg.trade ? "target" : "done";
      yield* this.pickMenu(menu, idx(want));
      return;
    }
    if (idx(msg.end) >= 0) {                // the map menu
      if (it && it.kind === "end") { it.stage = "done"; this.intent = null; yield* this.pickMenu(menu, idx(msg.end)); }
      else yield* this.press("B", 2, 10);
      return;
    }
    if (idx(msg.use) >= 0) {                // item submenu (Use / Equip / ...)
      if (it) it.stage = "done";
      yield* this.pickMenu(menu, idx(msg.use));
      return;
    }
    if (it && it.stage === "weapon") {
      // The weapon list: pick the row for the planned weapon (rows carry their inventory slot).
      it.stage = "target";
      const row = it.weaponSlot !== undefined ? m.items.findIndex((i) => i.number === it.weaponSlot) : -1;
      if (row > 0) yield* this.pickMenu(menu, row); else yield* this.press("A", 2, 10);
      return;
    }
    if (it && it.stage === "itemList") {
      const row = m.items.findIndex((i) => i.number === it.slot);
      it.stage = "itemSub";
      yield* this.pickMenu(menu, row >= 0 ? row : 0);
      return;
    }
    // The route choice after Chapter 8 ("follow Eirika / follow Ephraim"): pick the chosen lord.
    const names = m.items.map((i) => (i.msg ? this.text(i.msg) : ""));
    const routeIdx = names.findIndex((t) => t.includes(this.route === "ephraim" ? "Ephraim" : "Eirika"));
    if (routeIdx >= 0 && names.some((t) => t.includes("Ephraim")) && names.some((t) => t.includes("Eirika"))) {
      this.say(`Choosing ${this.route === "ephraim" ? "Ephraim" : "Eirika"}'s route`);
      yield* this.pickMenu(menu, routeIdx);
      return;
    }
    // Any other menu (yes/no prompts, chapter-end screens): take the first choice.
    this.say("Confirming a menu");
    yield* this.press("A", 2, 14);
  }

  *onTarget(proc) {
    const it = this.intent;
    // currentTarget -> SelectTarget { s8 x, s8 y, u8 uid, ... }
    const cur = () => { const t = this.r32(proc.addr + 0x30); return t ? { x: this.s8(t), y: this.s8(t + 1), uid: this.r8(t + 2) } : null; };
    const match = (c) => c && (it.targetXY ? c.x === it.targetXY.x && c.y === it.targetXY.y : c.uid === it.target.index);
    if (it && it.stage === "target" && (it.target || it.targetXY)) {
      for (let k = 0; k < 12 && !match(cur()); k++) yield* this.press("RIGHT", 2, 6);
      if (!match(cur())) this.say("Target not in reach, taking the nearest");
      it.stage = "done";
      yield* this.press("A", 2, 10);
      return;
    }
    yield* this.press("A", 2, 10);
  }

  // ---- Planning ------------------------------------------------------------------------
  // Movement costs depend on the weather (gPlaySt+0x15): rain uses table 1, snow and snowstorms table 2.
  costTable(u) {
    const w = this.r8(this.g.chapterData + 0x15);
    return this.r32(u.classPtr + 0x38 + (w === 4 ? 4 : w === 1 || w === 2 ? 8 : 0));
  }
  terrainBonus(u, terr, off) { const p = this.r32(u.classPtr + off); return p ? this.s8(p + terr) : 0; }

  reach(u, m, blocked, maxCost, extra) {
    // Dijkstra over terrain costs. `blocked` = tiles this unit cannot pass.
    const ct = this.costTable(u), cost = new Map(), key = (x, y) => y * 64 + x;
    const start = key(u.x, u.y); cost.set(start, 0);
    const open = [[0, u.x, u.y]];
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [c, x, y] = open.shift();
      if (c > (cost.get(key(x, y)) ?? 1e9)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const k = key(nx, ny);
        if (blocked.has(k)) continue;
        let step = this.s8(ct + m.t[ny][nx]);
        if (step < 0 && extra && extra[m.t[ny][nx]]) step = extra[m.t[ny][nx]];
        if (step < 0) continue;
        const nc = c + step;
        if (nc > maxCost) continue;
        if (nc < (cost.get(k) ?? 1e9)) { cost.set(k, nc); open.push([nc, nx, ny]); }
      }
    }
    return cost;
  }

  distField(u, m, goals, extra) {
    const ct = this.costTable(u), key = (x, y) => y * 64 + x, dist = new Map(), open = [];
    for (const g of goals) { dist.set(key(g.x, g.y), 0); open.push([0, g.x, g.y]); }
    const cost = (x, y) => { const tt = m.t[y][x]; let c = this.s8(ct + tt); if (extra && extra[tt]) c = c < 0 ? extra[tt] : Math.max(c, extra[tt]); return c; }; // extra: route cost for doors/walls, and a higher cost for lava
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [c, x, y] = open.shift();
      if (c > (dist.get(key(x, y)) ?? 1e9)) continue;
      const here = cost(x, y); // stepping out of this tile toward the goal costs what entering it would
      if (here < 0 && c > 0) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const step = cost(nx, ny); if (step < 0) continue;
        const nc = c + Math.max(1, here < 0 ? 1 : here);
        if (nc < (dist.get(key(nx, ny)) ?? 1e9)) { dist.set(key(nx, ny), nc); open.push([nc, nx, ny]); }
      }
    }
    return dist;
  }

  static makeTrueHitTable() {
    const t = [];
    for (let h = 0; h <= 100; h++) { let c = 0; for (let a = 0; a < 100; a++) for (let b = 0; b < 100; b++) if (a + b < 2 * h) c++; t.push(c / 10000); }
    return t;
  }

  // One side's strike numbers against the other.
  strike(a, aw, aTile, d, dw, dTile, m) {
    if (!aw) return null;
    const dist = Math.abs(aTile.x - dTile.x) + Math.abs(aTile.y - dTile.y);
    if (dist < aw.min || dist > aw.max) return null;
    const magic = (aw.type >= 5 && aw.type <= 7) || (aw.type === 11 && (aw.attr & 2) !== 0);
    const tri = FEBot.triangle(aw ? aw.type : -1, dw ? dw.type : -1);
    const terr = m.t[dTile.y][dTile.x];
    const eff = aw.eff.includes(d.classId) ? 3 : 1;
    // Luna ignores resistance (the Scorched Sand Shamans carry it; it was rated 0 damage on Knoll).
    if (!this._lunaIds) { this._lunaIds = new Set(); for (let i = 1; i < 0xC0; i++) if (this.text(this.r16(this.g.itemData + i * this.g.itemSize)) === "Luna") this._lunaIds.add(i); }
    const ignoreRes = this._lunaIds.has(aw.id);
    // Eclipse (might 255) halves the target's HP instead of dealing normal damage.
    const dmg = aw.might >= 255 ? Math.floor(d.hp / 2) : Math.max(0, a.pow + aw.might * eff + tri - (magic ? (ignoreRes ? 0 : d.res) : d.def) - this.terrainBonus(d, terr, magic ? 0x4C : 0x48));
    const as = (u, w) => u.spd - Math.max(0, (w ? w.wt : 0) - u.con);
    const hit = Math.max(0, Math.min(100, aw.hit + a.skl * 2 + (a.lck >> 1) + tri * 15
      - (as(d, dw) * 2 + d.lck + this.terrainBonus(d, terr, 0x44))));
    // Critical chance: weapon crit + half skill, plus 15 for the critical classes, minus the target's luck.
    const critCls = /Swordmaster|Berserker|Sniper|Assassin/.test(this.text(this.r16(a.classPtr || 0)));
    const crit = Math.max(0, (aw.crit || 0) + (a.skl >> 1) + (critCls ? 15 : 0) - (d.lck || 0));
    return { dmg, p: this.trueHit[hit], hit, crit, doubles: as(a, aw) - as(d, dw) >= 4 };
  }
  static triangle(a, b) {
    const phys = { 0: 2, 2: 1, 1: 0 }, mag = { 5: 7, 7: 6, 6: 5 }; // key beats value
    if (phys[a] === b || mag[a] === b) return 1;
    if (phys[b] === a || mag[b] === a) return -1;
    return 0;
  }
  // Full exchange: attacker strikes, defender counters, then whoever doubles strikes again.
  combat(a, aw, aTile, d, dw, dTile, m) {
    const sa = this.strike(a, aw, aTile, d, dw, dTile, m);
    if (!sa) return null;
    const sd = this.strike(d, dw, dTile, a, aw, aTile, m);
    const order = [["a", sa], ...(sd ? [["d", sd]] : []), ...(sa.doubles ? [["a", sa]] : []), ...(sd && sd.doubles ? [["d", sd]] : [])];
    let pKill = 0, pDie = 0, expDealt = 0, expTaken = 0;
    const walk = (i, ahp, dhp, pr) => {
      if (pr < 1e-4) return;
      if (dhp <= 0) { pKill += pr; return; }
      if (ahp <= 0) { pDie += pr; return; }
      if (i >= order.length) return;
      const [who, s] = order[i];
      if (who === "a") { expDealt += pr * s.p * Math.min(s.dmg, dhp); walk(i + 1, ahp, dhp - s.dmg, pr * s.p); walk(i + 1, ahp, dhp, pr * (1 - s.p)); }
      else { expTaken += pr * s.p * Math.min(s.dmg, ahp); walk(i + 1, ahp - s.dmg, dhp, pr * s.p); walk(i + 1, ahp, dhp, pr * (1 - s.p)); }
    };
    walk(0, a.hp, d.hp, 1);
    return { pKill, pDie, expDealt, expTaken, sa, sd };
  }

  plan(units, ready) {
    const m = this.map(), key = (x, y) => y * 64 + x;
    const pairs = this.talkPairs(), T = this.g.terrain;
    // Who joined during this chapter (protect them while they are new) and the army's ranking.
    if (this._rosterCh !== this.chapter()) { this._rosterCh = this.chapter(); this._startIds = new Set(units.filter((u) => u.side === "blue").map((u) => u.charId)); }
    const scores = this.armyScores(units.filter((u) => u.side === "blue"));
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const median = ranked.length ? scores.get(ranked[Math.floor(ranked.length / 2)]) : 0;
    const blueIds = new Set(units.filter((u) => u.side === "blue").map((u) => u.charId));
    // Enemies who join if the right unit talks to them: never attack them.
    const recruit = new Map(); // charId of target -> charId of talker
    // A unit counts as recruitable if its talker is alive anywhere on the map, even if the talker
    // has not joined yet (Ross must join before he can recruit Garcia): never attack those.
    const aliveIds = new Set(units.map((u) => u.charId));
    // A talk that was already used (or offered no Talk command) is not tried again; another
    // talker for the same unit is (Innes -> Gerik did not recruit him; Tethys -> Gerik can).
    this.talkTried = this.talkTried || new Set();
    const fresh = pairs.filter((p) => !this.talkTried.has(`${this.chapter()}:${p.a}>${p.b}`));
    for (const p of fresh) if (blueIds.has(p.a) && !recruit.has(p.b)) recruit.set(p.b, p.a);
    // Green allies on a talk list are spared and protected even before their recruiter joins
    // (Gerik and Tethys also join by surviving the chapter). An ENEMY recruit such as Marisa is only
    // spared while her recruiter is already on the team; otherwise she is fought like any enemy.
    const sideOf = new Map(units.map((u) => [u.charId, u.side]));
    for (const p of fresh) if (!recruit.has(p.b) && aliveIds.has(p.a) && sideOf.get(p.b) === "green") recruit.set(p.b, p.a);
    for (const p of pairs) if (!recruit.has(p.b) && aliveIds.has(p.a) && sideOf.get(p.b) === "green") recruit.set(p.b, -1);
    const allEnemies = units.filter((u) => u.side === "red");
    const enemies = allEnemies.filter((u) => !recruit.has(u.charId));
    // Do not end the chapter while someone can still be recruited (up to turn 40): keep the last
    // enemy alive in a rout, spare the boss in a boss chapter, and hold off seizing.
    const goal = this.goalType();
    // ...including enemy recruits whose recruiter is already on the team (Eirika -> Cormag): finish the
    // chapter only once they have been talked to (or turn 40 passes).
    const holdEnd = units.some((x) => x.side !== "blue" && recruit.get(x.charId) > 0 && blueIds.has(recruit.get(x.charId))) && this.turn() < 40;
    // Every recruiter on the team who can still talk to each target (Innes: Eirika or Tana).
    const talkersOf = new Map();
    for (const p of fresh) if (blueIds.has(p.a)) { if (!talkersOf.has(p.b)) talkersOf.set(p.b, []); talkersOf.get(p.b).push(p.a); }
    // Paid recruits: Rennac joins Eirika only for 10,000 gold but L'Arachel for free, so while
    // L'Arachel is on the team she is the one who goes to talk to him.
    const paid = [[0x1C, 0x01, 0x19]]; // [recruit, talker who costs gold, free talker]
    for (const [r, costly, free] of paid) {
      const ts = talkersOf.get(r);
      if (ts && ts.includes(free) && ts.includes(costly)) ts.splice(ts.indexOf(costly), 1);
    }
    const talkable = units.filter((u) => u.side !== "blue" && recruit.has(u.charId) && (talkersOf.get(u.charId) || []).length);
    const blues = units.filter((u) => u.side === "blue");
    const notRed = units.filter((u) => u.side !== "red");
    const occupied = new Map(units.map((u) => [key(u.x, u.y), u]));
    const seize = [];
    if (this.goalType() === 0)
      for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (this.g.seizeTerrains.includes(m.t[y][x])) seize.push({ x, y });
    const breakable = [], doors = [], armories = [], vendors = [];
    const gold = this.r32(this.g.gold);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (m.t[y][x] === T.wallDamaged || m.t[y][x] === T.snag) breakable.push({ x, y });
      if (m.t[y][x] === T.door) doors.push({ x, y });
      if (m.t[y][x] === T.armory) armories.push({ x, y });
      if (m.t[y][x] === T.vendor) vendors.push({ x, y });
    }
    // Who can open doors: if nobody can, routes must not go through them.
    const keyIds = [this.g.items.doorKey, this.g.items.lockpick];
    // A Rogue (Rennac) opens doors without a key.
    const isRogue = (b) => this.text(this.r16(b.classPtr)) === "Rogue";
    const armyHasKey = blues.some((b) => isRogue(b) || b.items.some((i) => keyIds.includes(i.id)));
    const through = { [T.wallDamaged]: 3, [T.snag]: 3 }; // for route-finding only
    if (armyHasKey) through[T.door] = 6;
    // Routes go round known lava where they can (each lava square counts as 3 steps).
    if (this.hazardTerrain) for (const ht of this.hazardTerrain) if (through[ht] === undefined) through[ht] = 3;
    const doorSide = new Set(); // tiles next to a closed door
    for (const d of doors) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) doorSide.add(key(d.x + dx, d.y + dy));
    const seizeKeys = new Set(seize.map((s) => key(s.x, s.y)));

    // Where each enemy could strike next enemy phase (player units block their paths).
    // Units that still have to move this turn will not be where they stand now, so they do not
    // block enemy paths (Eirika stepping away opened the gap a monster came through).
    const readySet = new Set(ready.map((u) => u.addr));
    const blockForRed = new Set(notRed.filter((u) => !readySet.has(u.addr)).map((u) => key(u.x, u.y)));
    const threat = allEnemies.map((e) => {
      const w = this.weaponOf(e);
      if (!w) return { e, w, tiles: new Set() };
      // Bosses on thrones/gates usually hold position, but some step out to strike anyone in
      // range (they did in Chapter 12), so assume they can move unless it is the very square we
      // need to seize and nobody could reach it anyway.
      const stays = false;
      const r = stays ? new Map([[key(e.x, e.y), 0]]) : this.reach(e, m, blockForRed, e.mov);
      const tiles = new Set();
      // Every weapon it carries counts, not just the one in hand: a Ranger holding a sword still shoots
      // at range 2 (one killed Tana from two squares away in Hamill Canyon).
      const ws = this.weaponsOf(e); const lo = Math.min(w.min, ...ws.map((x) => x.min)), hi = Math.max(w.max, ...ws.map((x) => x.max));
      for (const k of r.keys()) {
        const ex = k % 64, ey = (k / 64) | 0;
        for (let dy = -hi; dy <= hi; dy++) for (let dx = -hi; dx <= hi; dx++) {
          const dd = Math.abs(dx) + Math.abs(dy);
          if (dd < lo || dd > hi) continue;
          tiles.add(key(ex + dx, ey + dy));
        }
      }
      return { e, w, ws: ws.length ? ws : [w], tiles };
    });

    // Long-range casters (Purge, Bolting...): the squares they can hit next turn, roughly.
    const siegeCasters = units.filter((e) => e.side === "red").map((e) => ({ e, w: this.weaponOf(e) }))
      .filter((c) => c.w && c.w.max >= 3 && c.w.type >= 5 && c.w.type <= 7);
    const inSiege = (x, y) => siegeCasters.some((c) => Math.abs(c.e.x - x) + Math.abs(c.e.y - y) <= c.e.mov + c.w.max);
    // Turtling (Casim's call): early in a chapter the army holds a tight camp around where it
    // started and lets the enemy come to it, fighting at the edge. It moves out once the enemy
    // thins out, stops coming, or the chapter drags on.
    if (!this.turtle || this.turtle.ch !== this.chapter()) {
      const bl = units.filter((u) => u.side === "blue");
      const cx = Math.round(bl.reduce((a, u) => a + u.x, 0) / Math.max(1, bl.length)), cy = Math.round(bl.reduce((a, u) => a + u.y, 0) / Math.max(1, bl.length));
      // camp on the closest square a unit is standing on (always a real, reachable square)
      const c0 = bl.sort((a, b) => (Math.abs(a.x - cx) + Math.abs(a.y - cy)) - (Math.abs(b.x - cx) + Math.abs(b.y - cy)))[0];
      this.turtle = { ch: this.chapter(), anchor: c0 ? { x: c0.x, y: c0.y } : { x: cx, y: cy }, init: units.filter((u) => u.side === "red").length };
    }
    const reds = units.filter((u) => u.side === "red");
    // Never camp inside a long-range caster's reach: shift the camp to the nearest square out of it.
    if (siegeCasters.length && inSiege(this.turtle.anchor.x, this.turtle.anchor.y)) {
      const m0 = this.map(); let best = null, bd = 1e9;
      for (let y = 0; y < m0.h; y++) for (let x = 0; x < m0.w; x++) {
        if (inSiege(x, y)) continue;
        const lu = units.find((b) => b.side === "blue" && this.g.lordIds.includes(b.charId)) || units.find((b) => b.side === "blue");
        if (lu && this.s8(this.costTable(lu) + m0.t[y][x]) <= 0) continue; // somewhere the army can stand
        const d = Math.abs(x - this.turtle.anchor.x) + Math.abs(y - this.turtle.anchor.y);
        if (d < bd) { bd = d; best = { x, y }; }
      }
      if (best) this.turtle.anchor = best;
    }
    if (this.goalType() === 2) { // a Survive map: camp around the green allies we must defend, if any
      let gw = units.filter((g) => g.side === "green");
      const thr = []; { const mm = this.map(); for (let y = 0; y < mm.h; y++) for (let x = 0; x < mm.w; x++) if (mm.t[y][x] === 0x1F) thr.push({ x, y }); }
      const nt = gw.filter((g) => thr.some((p) => Math.abs(p.x - g.x) + Math.abs(p.y - g.y) <= 3));
      if (nt.length) gw = nt; // the ones by the throne
      const un = gw.filter((g) => !/^(Rausten|Frelia|Renais|Grado|Jehanna|Carcino|Soldier|Monster|Bandit|Pirate|Remnant)$/.test(this.charName(g.charId)) && units.filter((h) => h.side === "green" && this.charName(h.charId) === this.charName(g.charId)).length === 1);
      if (un.length) gw = un; // ...Mansel himself
      if (gw.length) this.turtle.anchor = { x: Math.round(gw.reduce((a, g) => a + g.x, 0) / gw.length), y: Math.round(gw.reduce((a, g) => a + g.y, 0) / gw.length) };
    }
    const tA = this.turtle.anchor;
    // Stalemate: the same number of enemies for 6 turns (Chapter 14: only Carlyle left on the throne,
    // and everyone kept off the squares where he could kill them, for 60+ turns). Then the stronger
    // units go in anyway; a death is a rewind, and the retry tries something different.
    if (!this._stale || this._stale.ch !== this.chapter() || this._stale.n !== reds.length || this.turn() < this._stale.since)
      this._stale = { ch: this.chapter(), n: reds.length, since: this.turn() };
    const stale = this.turn() - this._stale.since >= 6;
    // If none of the sturdy units can even reach an enemy (the last Mogall in Village of Silence hovers
    // over cliffs only fliers can cross), the frail ones who can reach it go in too.
    const frail = (b) => b.maxHP < 25 || b.def < 6;
    let staleFrailToo = false;
    if (stale && reds.length) {
      const m0 = this.map(), tgt = reds.map((e) => ({ x: e.x, y: e.y }));
      staleFrailToo = !units.filter((b) => b.side === "blue" && !frail(b) && !this.g.lordIds.includes(b.charId))
        .some((b) => this.distField(b, m0, tgt, {}).get(b.y * 64 + b.x) !== undefined);
    }
    // In a Survive chapter (Last Hope) the army holds its ground the whole time instead of only early on.
    const surviveMap = this.goalType() === 2;
    const turtleOn = (surviveMap || (this.turn() <= 15 && reds.length > 0.4 * this.turtle.init)) &&
      reds.some((e) => Math.abs(e.x - tA.x) + Math.abs(e.y - tA.y) <= e.mov + 8);
    // ...and holds it at the doorways: the squares at the edge of the camp that open onto the rest of
    // the map. Sturdy units stand in them so enemies queue up in the corridors; the frail stay inside.
    const doorways = new Set();
    // Green allies on a Survive map are the ones to defend (Mansel and Rausten by the throne in Last
    // Hope; losing either ends the game): the camp forms around them, and the squares beside them
    // are for sturdy units to stand in.
    // Only the green allies by the throne (Mansel and the General beside him); Last Hope also has a
    // dozen ordinary Rausten soldiers on the green side scattered over the map, and counting them put
    // the camp's centre in the wrong place and asked for a camp too big to wall in.
    const throneSq = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.t[y][x] === 0x1F) throneSq.push({ x, y });
    const greensAll = surviveMap ? units.filter((g) => g.side === "green") : [];
    const nearThrone = throneSq.length ? greensAll.filter((g) => throneSq.some((p) => Math.abs(p.x - g.x) + Math.abs(p.y - g.y) <= 3)) : [];
    // ...and of those only the uniquely named one (Mansel): the General beside him shares his name with
    // every Rausten soldier, and the game only loses if Mansel dies (Fire Emblem Wiki, Last Hope).
    const uniq = (list) => list.filter((g) => !/^(Rausten|Frelia|Renais|Grado|Jehanna|Carcino|Soldier|Monster|Bandit|Pirate|Remnant)$/.test(this.charName(g.charId)) && list.filter((h) => this.charName(h.charId) === this.charName(g.charId)).length === 1 && greensAll.filter((h) => this.charName(h.charId) === this.charName(g.charId)).length === 1);
    const wards = uniq(nearThrone).length ? uniq(nearThrone) : nearThrone.length ? nearThrone : greensAll;
    const guardSq = new Set();
    for (const g of wards) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) guardSq.add(key(g.x + dx, g.y + dy));
    // The ring two squares out is where archers and mages would shoot from: worth filling too.
    const guardRing = new Set();
    for (const g of wards) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) === 2) guardRing.add(key(g.x + dx, g.y + dy));
    if (surviveMap) {
      const lordU = units.find((b) => b.side === "blue" && this.g.lordIds.includes(b.charId));
      if (lordU) {
        const ct0 = this.costTable(lordU);
        const ok = (x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h && this.s8(ct0 + m.t[y][x]) >= 0;
        const campOf = (R) => {
          const inCamp = new Map([[key(tA.x, tA.y), 0]]), q = [[tA.x, tA.y]];
          while (q.length) {
            const [x, y] = q.shift(), d = inCamp.get(key(x, y));
            if (d >= R) continue;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (ok(x + dx, y + dy) && !inCamp.has(key(x + dx, y + dy))) { inCamp.set(key(x + dx, y + dy), d + 1); q.push([x + dx, y + dy]); }
          }
          // Fill the notches a diamond leaves (a square outside touching two inside): otherwise a wall
          // square juts out and is hit from three sides (Franz at 16,15 in Last Hope, then the gap he left).
          for (let pass = 0; pass < 2; pass++) {
            const add = [];
            for (const k of inCamp.keys()) {
              const x = k % 64, y = (k / 64) | 0;
              for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (!ok(nx, ny) || inCamp.has(key(nx, ny))) continue;
                const touch = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([ex, ey]) => inCamp.has(key(nx + ex, ny + ey))).length;
                if (touch >= 2) add.push(key(nx, ny));
              }
            }
            for (const k of add) inCamp.set(k, R);
          }
          const doors = [];
          for (const k of inCamp.keys()) {
            const x = k % 64, y = (k / 64) | 0;
            if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ok(x + dx, y + dy) && !inCamp.has(key(x + dx, y + dy)))) doors.push(k);
          }
          return { inCamp, doors };
        };
        // With wards to defend, build a full wall (Casim's call, Last Hope): pick the camp size whose
        // edge has the fewest entrance squares, big enough to hold the army, so the sturdiest units can
        // seal every one of them and everyone else stays behind. Without wards, the old 4-step camp.
        let pick = campOf(4);
        if (wards.length && this.useWall) { // the full wall is off by default: too many squares for this army to hold
          const need = units.filter((b) => b.side === "blue").length + wards.length;
          let bestW = null;
          for (let R = 3; R <= 7; R++) { const c = campOf(R); if (c.inCamp.size >= need && (!bestW || c.doors.length <= bestW.doors.length)) bestW = c; }
          if (bestW) { pick = bestW; this.wallCamp = bestW.inCamp; } else this.wallCamp = null;
        } else this.wallCamp = null;
        for (const k of pick.doors) doorways.add(k);
      }
    }
    const convoy = this.convoyItems();
    const frontUnits = units.filter((b) => b.side === "blue" && (b.charId === 0x02 || ranked.indexOf(b.charId) < 3));
    const convoyHas = (u) => this.bestBuy(u, convoy, 1e9) >= 0;
    const greenRecruits = units.filter((g) => (g.side === "green" && recruit.has(g.charId)) || (g.side === "blue" && this.cannotAct(g)));
    // (sleeping teammates count too: anyone who can reach them is a priority to kill)
    let best = null;
    for (const u of ready) {
      const uw = this.weaponOf(u);
      const weakU = (scores.get(u.charId) ?? 1) < median || u.maxHP < 25 || !this.weaponOf(u);
      const ns = this.noSeize && this.noSeize.get(`${this.chapter()}:${u.charId}`);
      const otherLord = blues.some((b) => b !== u && this.g.lordIds.includes(b.charId));
      const lord = this.g.lordIds.includes(u.charId) && !(ns !== undefined && otherLord && this.turn() - ns < 3);
      const blockForBlue = new Set(enemies.map((e) => key(e.x, e.y)));
      const r = this.reach(u, m, blockForBlue, u.mov);
      // Distance-to-goal field (ignoring units) for moving forward.
      const has = (...ids) => u.items.some((i) => ids.includes(i.id));
      const doorKey = has(this.g.items.doorKey, this.g.items.lockpick) || isRogue(u);
      // Units with nothing to fight or heal with keep clear of the front.
      const armed = !!uw || u.items.some((i) => this.g.healStaves[i.id]);
      // Needs a weapon: none left (or nearly spent), can wield something, room to carry it, gold to pay.
      const wUses = u.items.reduce((n, i) => { const d = this.item(i.id); return n + ((d.attr & 1) && d.type <= 7 && d.type !== 4 && u.ranks[d.type] >= (d.rank || 1) ? i.uses : 0); }, 0);
      const canWield = u.ranks.some((r, ty) => r > 0 && ty !== 4);
      const level = this.r8(u.addr + 8);
      const keyUnit = u.charId === 0x02 || level >= 10; // Seth and other strong units never run dry
      // Shopping trips are given up after 6 turns in a chapter (the armory may be out of reach),
      // and a unit who still has a usable weapon only shops when the armory is close.
      this.shopSince = this.shopSince || new Map();
      const sk = `${this.chapter()}:${u.charId}`;
      let needsWeapon = canWield && u.items.length < 5 && gold >= 500 && wUses < (u.charId === 0x02 ? 40 : keyUnit ? 25 : 6) && armories.length > 0;
      if (needsWeapon) {
        if (!this.shopSince.has(sk)) this.shopSince.set(sk, this.turn());
        if (this.turn() - this.shopSince.get(sk) > 6) needsWeapon = false;
        else if (wUses > 0) { const f = this.distField(u, m, armories, through); if ((f.get(key(u.x, u.y)) ?? 999) > u.mov * 2) needsWeapon = false; }
      }
      // Healers whose staff broke (Natasha's Mend wore out in Carcino, Moulder's Heal in Village of
      // Silence, and nobody bought new ones) and a lord with no Vulnerary go to a vendor if the map
      // has one within reach.
      const hasStaffV = u.items.some((i) => this.g.healStaves[i.id]);
      const hasPotionV = u.items.some((i) => i.id === this.g.vulnerary || i.id === 0x6D);
      let needsItem = vendors.length > 0 && u.items.length < 5 && ((u.ranks[4] > 0 && !hasStaffV && gold >= 600) || (lord && !hasPotionV && gold >= 300));
      if (needsItem) {
        const vk = `v:${sk}`;
        if (!this.shopSince.has(vk)) this.shopSince.set(vk, this.turn());
        const f = this.distField(u, m, vendors, through);
        if (this.turn() - this.shopSince.get(vk) > 6 || (f.get(key(u.x, u.y)) ?? 999) > u.mov * 3) needsItem = false;
      }
      // Chase a recruit talk for at most 8 turns per chapter; past that the target is probably
      // out of reach (Tethys also joins on her own if she survives), so get on with the battle.
      this.talkSince = this.talkSince || new Map();
      const seizeGuarded = seize.some((sz) => reds.some((e) => Math.abs(e.x - sz.x) + Math.abs(e.y - sz.y) <= 2));
      const protRed = new Set(this.protectedEnemyRecruits());
      // Recruits still hidden in a locked room: head for the doors near them.
      const recruitDoors = [], hiddenTalkers = new Set(), hiddenPos = [];
      if (doors.length && protRed.size) {
        const [rb, rn] = this.g.units.red;
        for (let i = 0; i < rn; i++) {
          const a = rb + i * 0x48, ch = this.r32(a);
          if (!ch || !protRed.has(this.r8(ch + 4)) || !(this.r32(a + 0x0C) & US_HIDDEN)) continue;
          const hx = this.s8(a + 0x10), hy = this.s8(a + 0x11);
          hiddenPos.push({ x: hx, y: hy });
          // Every closed door within 8 squares (not just the nearest: Rennac's room is 4 from a door
          // nobody can reach and 5 from the one that leads in); the route picks whichever is reachable.
          for (const d of doors) if (Math.abs(d.x - hx) + Math.abs(d.y - hy) <= 8 && !recruitDoors.includes(d)) recruitDoors.push(d);
          for (const t of talkersOf.get(this.r8(ch + 4)) || []) hiddenTalkers.add(t);
        }
      }
      // Once that door opens the recruit may run for it (Rennac heads west and escapes), so his
      // talker walks to the door too, and the door is only opened with the talker close by.
      // Rennac runs the moment his door opens and outpaces L'Arachel, so "close by" is not enough: the
      // door opens only when his talker has not moved yet this turn and can reach him right after.
      // So the talker waits on the walkable square closest to him (Rennac's room is open to the north at
      // 22,10, which is also his way out), and the door opens once she stands there.
      const talkerNear = () => blues.some((b) => hiddenTalkers.has(b.charId) &&
        hiddenPos.some((p) => Math.abs(p.x - b.x) + Math.abs(p.y - b.y) <= 2));
      const waitSpots = [];
      if (hiddenTalkers.has(u.charId)) {
        const ct = this.costTable(u);
        for (const p of hiddenPos) {
          let bd = 99, spots = [];
          for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = p.x + dx, y = p.y + dy;
            if (x < 0 || y < 0 || x >= m.w || y >= m.h || this.s8(ct + m.t[y][x]) < 0 || m.t[y][x] === T.door) continue;
            const d = Math.abs(dx) + Math.abs(dy);
            if (d < bd) { bd = d; spots = [{ x, y }]; } else if (d === bd) spots.push({ x, y });
          }
          waitSpots.push(...spots);
        }
      }
      const myTalks = talkable.filter((t) => {
        if (!(talkersOf.get(t.charId) || []).includes(u.charId)) return false;
        // The lord leaves a recruit to another talker if there is one (Franz for Amelia): Eirika
        // charging across Hamill Canyon from turn 1 to reach Amelia got her killed on turns 1-2.
        const lordU = this.g.lordIds.includes(u.charId);
        if (lordU && (talkersOf.get(t.charId) || []).some((id) => id !== u.charId && !this.g.lordIds.includes(id) && blues.some((b) => b.charId === id))) return false;
        const tk = `${this.chapter()}:${u.charId}>${t.charId}`;
        if (!this.talkSince.has(tk)) this.talkSince.set(tk, this.turn());
        // ...except an enemy recruit we now protect (Cormag): a rewind undoes his death, so if the
        // talk is given up he just keeps dying. Keep chasing him until he is talked into joining.
        // Same for green allies (Innes in Carcino): they are protected too, and the chapter is held open
        // for them, so giving up the talk after 8 turns only left them unrecruited until turn 40.
        if (t.side === "red" || t.side === "green") return true;
        return this.turn() - this.talkSince.get(tk) <= 8;
      });
      // A lord with someone to recruit goes and does it, taking ordinary risks (rewinds cover the rest).
      // ...but after she has fallen once (caution raised), she goes back to being careful.
      // The lord stays careful even with someone to recruit (she charged into enemies in Chapter 12);
      // the recruit talk itself still scores very high when it is safe to make.
      // An enemy who joins only if the lord talks to him before a Survive chapter runs out its turns
      // (Cormag in Hamill Canyon: the chapter ends on its own, so it cannot be held open). The lord
      // goes after him for real: normal risk instead of extra-careful, and a strong pull toward him.
      // Green allies who fight on their own (Syrene flies into the Wyverns in River of Regrets and dies)
      // are just as urgent: talk them into the army before they get themselves killed.
      const urgentTalk = myTalks.some((t) => (t.side === "red" && protRed.has(t.charId)) || t.side === "green");
      const toRecruitDoor = hiddenTalkers.has(u.charId) && !myTalks.length && recruitDoors.length;
      const greenRace = myTalks.some((t) => t.side === "green");
      const isFlier = /Pegasus|Falco|Wyvern/.test(this.text(this.r16(u.classPtr)));
      // A recruit who ran off the map on an earlier try (Rennac) leaves by the same way again, so his
      // talker goes to wait at that exit, before he is even out of his room.
      const exitSpots = [];
      for (const id of protRed) {
        const ex = this.recruitExits && this.recruitExits.get(`${this.chapter()}:${id}`);
        if (ex && (talkersOf.get(id) || []).includes(u.charId)) exitSpots.push(ex);
      }
      // ...but she only drops her extra care on the turn she can actually reach him: walking in from
      // far off at normal risk got Eirika killed on turns 6-7 of Hamill Canyon again and again.
      const talkReachable = urgentTalk && myTalks.some((mt) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => r.has(key(mt.x + dx, mt.y + dy))));
      const lordCareful = lord && !talkReachable;
      // Who could hand this unit a weapon (if it has none): head for them.
      const roomFor = u.items.length < 5 || this.junkSlot(u) >= 0;
      const donors = !uw && canWield && roomFor ? blues.filter((a) => a !== u && a.items.some((i) => {
        const d = this.item(i.id), theirs = this.weaponsOf(a).map((w) => w.slot);
        return (d.attr & 1) && d.type <= 7 && d.type !== 4 && u.ranks[d.type] && !(d.rank && u.ranks[d.type] < d.rank) && (!theirs.includes(i.slot) || theirs.length > 1);
      })) : [];
      // A healer with no staff heads for a teammate carrying one he cannot use.
      if (u.ranks[4] && !u.items.some((i) => this.g.healStaves[i.id]) && roomFor)
        for (const a of blues) if (a !== u && !a.ranks[4] && a.items.some((i) => this.g.healStaves[i.id])) donors.push(a);
      // Badly hurt and nothing to drink: head for a teammate who carries a potion.
      const hasPotion = u.items.some((i) => i.id === this.g.vulnerary || i.id === 0x6D);
      if (u.hp * 2 < u.maxHP && !hasPotion && roomFor) for (const a of blues) if (a !== u && a.items.some((i) => i.id === this.g.vulnerary || i.id === 0x6D)) donors.push(a);
      const lordForSupply = !uw && canWield && roomFor && convoyHas(u) ? blues.find((b) => this.g.lordIds.includes(b.charId) && b !== u) : null;
      if (lordForSupply) donors.push(lordForSupply);
      // The front line hunts a long-range caster first; everyone else keeps away from him.
      const hunt = siegeCasters.length && frontUnits.includes(u) && uw && !lord;
      // A healer heads for the lord when she is badly hurt.
      const hurtLordU = blues.find((b) => this.g.lordIds.includes(b.charId) && b.hp * 2 < b.maxHP);
      const isHealer = u.items.some((i) => this.g.healStaves[i.id]);
      if (isHealer && hurtLordU && hurtLordU !== u) donors.unshift(hurtLordU);
      // While turtling, everyone (except a unit with a recruit to talk to, or a long-range-caster
      // hunter) keeps to the camp; the strongest stand on its edge, the rest inside it.
      // On a Survive map, a group that starts walled off from the lord (Joshua, Forde, Gerik and
      // Vanessa in the north-west room of Last Hope) holds its own room instead of trying to cross
      // enemy-filled corridors to the main camp.
      this._startPos = this._startPos && this._startPos.ch === this.chapter() ? this._startPos : { ch: this.chapter(), pos: new Map() };
      if (!this._startPos.pos.has(u.charId)) this._startPos.pos.set(u.charId, { x: u.x, y: u.y });
      let campAt = tA;
      // (Tried: with wards to defend, sending the cut-off group to the main camp. In Last Hope the walk
      // through the enemy corridors cost more lives than holding the room, best turn 6 against 8, so
      // the group holds its room again.)
      if (surviveMap && !lord) {
        const toCamp = this.distField(u, m, [tA], {}).get(key(u.x, u.y));
        // A flier can usually go over what blocks the others (Vanessa, the frailest of the north-west
        // group, kept dying in that room): if it can reach the main camp within three moves, it joins.
        const flier = /Pegasus|Falco|Wyvern/.test(this.text(this.r16(u.classPtr)));
        if (flier && toCamp !== undefined && toCamp <= u.mov * 3) { /* joins the main camp */ }
        else if (toCamp === undefined || toCamp > 12) {
          // ...around the middle of that group's starting squares, not this unit's own: Gerik started
          // in the doorway of the north-west room and was pinned there, taking every hit.
          const me = this._startPos.pos.get(u.charId);
          const grp = [...this._startPos.pos.values()].filter((p) => Math.abs(p.x - me.x) + Math.abs(p.y - me.y) <= 6);
          const cx = Math.round(grp.reduce((a, p) => a + p.x, 0) / grp.length), cy = Math.round(grp.reduce((a, p) => a + p.y, 0) / grp.length);
          const ct = this.costTable(u);
          let bestT = me, bd = 99;
          for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= m.w || y >= m.h || this.s8(ct + m.t[y][x]) < 0) continue;
            if (Math.abs(dx) + Math.abs(dy) < bd) { bd = Math.abs(dx) + Math.abs(dy); bestT = { x, y }; }
          }
          campAt = bestT;
        }
      }
      const camping = turtleOn && !myTalks.length && !hunt && !donors.length;
      const holdSq = this.wallCamp && wards.length ? doorways : guardSq; // with a wall, its squares are the posts
      const wardGuard = holdSq.has(key(u.x, u.y)) && (frontUnits.includes(u) || (u.maxHP >= 30 && u.def >= 8)) && !(u.ranks[4] > 0 && u.items.some((i) => this.g.healStaves[i.id]));
      // A lord waiting at a locked door (Eirika outside the throne room in Chapter 14): whoever has a
      // key or lockpick goes to that door, wherever they are on the map.
      // ...and to the door of a locked room with a recruit hidden inside (Rennac, Chapter 14).
      const stuckDoors = doorKey && !lord ? doors.filter((d) => blues.some((b) => this.g.lordIds.includes(b.charId) &&
        Math.abs(b.x - d.x) + Math.abs(b.y - d.y) <= 3) || recruitDoors.includes(d)) : [];
      const promoted = (this.r32(u.classPtr + 0x28) & 0x100) !== 0;
      this.promoTried = this.promoTried || new Set();
      // Which promotion item fits which class, by the class's own name (works for hacks that keep the names).
      const cls = this.text(this.r16(u.classPtr));
      // Class names are shortened in the game's text ("Pegasus Kn."), so compare the first 8 letters.
      const sameCls = (a, b) => a.slice(0, 8) === b.slice(0, 8);
      const fitsFor = (cl, cid) => (id) => id === 0x88 || ({
        0x64: ["Fighter", "Mercenary", "Myrmidon"], 0x65: ["Cavalier", "Knight"], 0x66: ["Archer"],
        0x67: ["Pegasus Knight", "Wyvern Rider"], 0x68: ["Mage", "Priest", "Cleric", "Monk", "Shaman", "Troubadour"],
        0x97: ["Pirate", "Thief"], 0x98: cid === 0x01 ? ["Lord"] : [], 0x99: cid === 0x0F ? ["Lord"] : [],
      }[id] || []).some((n) => sameCls(n, cl));
      const fitsOld = (id) => id === 0x88 || ({
        0x64: ["Fighter", "Mercenary", "Myrmidon"], 0x65: ["Cavalier", "Knight"], 0x66: ["Archer"],
        0x67: ["Pegasus Knight", "Wyvern Rider"], 0x68: ["Mage", "Priest", "Cleric", "Monk", "Shaman", "Troubadour"],
        0x97: ["Pirate", "Thief"], 0x98: u.charId === 0x01 ? ["Lord"] : [], 0x99: u.charId === 0x0F ? ["Lord"] : [],
      }[id] || []).includes(cls);
      const fits = fitsFor(cls, u.charId);
      // A low-priority unit only uses a promotion item if no one else in the army could.
      const someoneElse = (id) => blues.some((b) => b !== u && !this.lowPriority(b.charId) && !(this.r32(b.classPtr + 0x28) & 0x100) && this.r8(b.addr + 8) >= 10 && fitsFor(this.text(this.r16(b.classPtr)), b.charId)(id));
      // Lords wait until level 15 for better stats, but use their brace by Last Hope (the Rausten map)
      // at the latest, or any chapter after it: Casim's call. Everyone else promotes from level 10.
      // Chapters are matched by title, since the two routes number them differently.
      const lateTitles = ["Last Hope", "Darkling Woods", "Sacred Stone"];
      const lordWait = this.g.lordIds.includes(u.charId) && level < 15 && !lateTitles.includes(this.chapterTitle(this.chapter()) || "");
      const promo = !promoted && level >= 10 && !lordWait ? u.items.find((i) => this.g.promoItems.includes(i.id) && fits(i.id) && !this.promoTried.has(`${u.charId}:${i.id}`) && !(this.lowPriority(u.charId) && someoneElse(i.id))) : null;
      // Promotion items sit with whoever picked them up (Seth was carrying a Knight Crest and a Hero
      // Crest). A unit ready to promote takes a fitting one from a neighbour who cannot use it, and
      // walks over to that neighbour first.
      const promoDonors = !promoted && level >= 10 && !promo && !this.lowPriority(u.charId) && (u.items.length < 5 || this.junkSlot(u) >= 0)
        ? blues.filter((a) => a !== u && a.items.some((i) => this.g.promoItems.includes(i.id) && fits(i.id) &&
            !(!(this.r32(a.classPtr + 0x28) & 0x100) && this.r8(a.addr + 8) >= 10 && fitsFor(this.text(this.r16(a.classPtr)), a.charId)(i.id)))) : [];
      for (const a of promoDonors) donors.push(a);
      // A badly hurt lord walks to a healer instead of on toward the objective (Eirika at 4 HP was alone
      // in a corner of Hamill Canyon, out of every healer's reach, and died there over and over).
      // ...and so does anyone down to a quarter of their HP (Seth at 6/47 in Two Faces of Evil kept
      // walking toward the Gorgons and dying on squares rated safe).
      const healersNear = (lord && u.hp * 2 < u.maxHP) || u.hp * 4 < u.maxHP ? blues.filter((b) => b !== u && b.ranks[4] > 0 && b.items.some((i) => this.g.healStaves[i.id])) : [];
      const goals = healersNear.length ? healersNear.map((b) => ({ x: b.x, y: b.y })) : exitSpots.length && !myTalks.some((mt) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => r.has(key(mt.x + dx, mt.y + dy)))) ? exitSpots : camping ? [campAt] : stuckDoors.length ? stuckDoors.map((d) => ({ x: d.x, y: d.y })) : toRecruitDoor ? (waitSpots.length ? waitSpots : recruitDoors.map((d) => ({ x: d.x, y: d.y }))) : hunt ? siegeCasters.map((c) => ({ x: c.e.x, y: c.e.y })) : donors.length ? donors.map((a) => ({ x: a.x, y: a.y })) : needsWeapon ? armories : needsItem ? vendors : myTalks.length ? myTalks.map((e) => ({ x: e.x, y: e.y }))
        : lord && seize.length ? seize : enemies.map((e) => ({ x: e.x, y: e.y }));
      const chestKey = has(this.g.items.chestKey, this.g.items.lockpick, this.g.items.chestKeys);
      // True walking distance to the nearest goal: a distance field grown out from the goals
      // over this unit's terrain costs (units ignored, breakable walls and doors passable).
      const field = this.distField(u, m, goals, through);
      // Endgame: units that cannot safely hit the last enemies make room for the ones who can
      // (Innes with his bow against Pablo) instead of crowding the only approach.
      let safeHitter = false;
      if (enemies.length && enemies.length <= 3) for (const e of enemies) for (const w of this.weaponsOf(u)) {
        const c = this.combat(u, w, { x: e.x, y: Math.min(m.h - 1, e.y + w.max) }, e, this.weaponOf(e), { x: e.x, y: e.y }, m);
        if (c && c.pDie < 0.2) safeHitter = true;
      }
      const clearOut = !(stale && (!(u.maxHP < 25 || u.def < 6) || staleFrailToo)) && enemies.length && enemies.length <= 3 && this.turn() > 12 && !safeHitter && !lord && !myTalks.length;
      // Someone carrying a teammate to safety heads AWAY from the enemy, not into it.
      const ferrying = (u.state & 0x10) !== 0;
      // A cut-off group holding its own room keeps tight (Gerik kept stepping out of the north-west room
      // of Last Hope into the corridor and dying there).
      const campR = lord ? 1 : campAt !== tA ? 1 : frontUnits.includes(u) ? 3 : 2; // the lord keeps to the middle; the front line stands at the edge
      const goalDist = (t) => (camping ? Math.max(0, (field.get(t) ?? 30) - campR) * 2 : ferrying ? -Math.min(10, field.get(t) ?? 10) : donors.length ? (field.get(t) ?? 999) : clearOut ? -Math.min(8, field.get(t) ?? 8) * 0.7
        : !armed && !needsWeapon && !myTalks.length && !toRecruitDoor ? -Math.min(6, field.get(t) ?? 6) * 0.5 : goals.length ? (field.get(t) ?? 999) : 0);
      const vul = u.items.find((i) => i.id === this.g.vulnerary || i.id === 0x6D); // Vulnerary or Elixir
      const carrying = (u.state & 0x10) !== 0; // US_RESCUING
      let carried = null;
      if (carrying) {
        const idx = this.r8(u.addr + 0x1B);
        for (const [side, [base, n]] of Object.entries(this.g.units)) for (let i = 0; i < n; i++) {
          const a = base + i * 0x48;
          if (this.r32(a) && this.r8(a + 0x0B) === idx) carried = this.readUnit(a, side);
        }
      }
      for (const [t, c] of r) {
        const occ = occupied.get(t);
        if (occ && occ !== u) continue;
        if (this.badTiles && this.badTiles.has(`${this.turn()}:${u.addr}:${t % 64},${(t / 64) | 0}`)) continue;
        if (this.failedSquares && this.failedSquares.has(`${this.chapter()}:${this.turn()}:${u.charId}@${t % 64},${(t / 64) | 0}`)) continue;
        const tile = { x: t % 64, y: (t / 64) | 0 };
        const danger = (killed) => {
          // At most a few enemies can reach one tile at once, so count only the three most dangerous.
          const hits = [];
          // Lava / fire squares (Two Faces of Evil) burn whoever ends the turn on them for about 10 HP;
          // the bot learns which terrain does that the first time it sees HP drop with no battle.
          if (this.hazardTerrain && this.hazardTerrain.has(m.t[tile.y][tile.x])) hits.push({ exp: 10, max: 10 });
          // Fliers take triple damage from bows: a square two or more archers can reach counts as
          // deadly for them (Cormag stays in Last Hope, but never where a second archer can join in).
          if (isFlier) {
            let bows = 0;
            for (const th of threat) if (th.e !== killed && th.tiles.has(t) && (th.ws || []).some((w) => w.type === 3)) bows++;
            if (bows >= 2) hits.push({ exp: u.hp, max: u.hp * 2 });
          }
          for (const th of threat) {
            if (th.e === killed || !th.tiles.has(t)) continue;
            // The recruit we are walking over to talk to joins on our turn; his reach is not a danger.
            if (urgentTalk && myTalks.some((mt) => mt.charId === th.e.charId)) continue;
            // Strike from where it stands if in range, else from a square at its weapon's minimum
            // range (long-range tomes such as Bolting cannot hit from next door).
            // Try every weapon it carries and keep the worst: a Cavalier holding a Javelin hits harder with
            // its Steel Lance up close (two of them killed Knoll from squares rated safe).
            let worst = null;
            for (const ew of th.ws || [th.w]) {
              const rmin = Math.max(1, ew.min || 1);
              const from = tile.x + rmin < m.w ? { x: tile.x + rmin, y: tile.y } : { x: Math.max(0, tile.x - rmin), y: tile.y };
              const s = this.strike(th.e, ew, { x: th.e.x, y: th.e.y }, u, uw, tile, m) || this.strike(th.e, ew, from, u, uw, tile, m);
              if (!s) continue;
              const n = s.doubles ? 2 : 1;
              // A likely critical (Swordmasters, Killer weapons: 20%+) can triple one hit: count it in the
              // worst case for frail units (Natasha died on squares rated safe to a Swordmaster in Last Hope).
              const critMax = s.crit >= 20 && (u.maxHP < 25 || u.def < 6) ? s.dmg * 2 : 0;
              if (!worst || s.dmg * n + critMax > worst.max) worst = { exp: s.dmg * n * s.p, max: s.dmg * n + critMax };
            }
            // Stone does no damage but turns the target to stone, and a stoned unit is then hit by
            // everything that can reach it: for a hurt unit, being in Stone's reach is as good as dying
            // (Seth at 6 HP in Two Faces of Evil). Counted as a sure hit worth half its HP.
            if ((th.ws || []).some((ew) => this.isStone(ew.id))) hits.push({ exp: u.hp * 0.5, max: u.hp * 2 < u.maxHP ? u.hp : u.hp * 0.5 });
            if (!worst) continue;
            hits.push(worst);
          }
          hits.sort((a, b) => b.exp - a.exp);
          let exp = 0, max = 0;
          // After a rewind, assume more of them can reach (the last estimate was too hopeful).
          // Weak units (and everyone after a rewind) assume every enemy that can reach will come.
          // The lord counts every one of them too (four Brigands can surround her).
          const allHits = weakU || this.caution || this.g.lordIds.includes(u.charId);
          // On a Survive map enemies swarm, so everyone counts four attackers, not three (Gerik died at 30 HP to five in Last Hope).
          // pAll: the chance every counted attack lands its worst case (each hit's chance is exp/max), the
          // rough chance the worst case happens at all; a lord can take a square that is deadly only if
          // everything goes wrong.
          let pAll = 1;
          for (const h of hits.slice(0, allHits || surviveMap ? Math.min(4, hits.length) : 3)) { exp += h.exp; max += h.max; pAll *= h.max > 0 ? Math.min(1, h.exp / h.max) : 1; }
          return { exp, max, pAll };
        };
        // Grow bolder the longer a chapter drags on, so passive enemies cannot stall a run.
        // ...but never right after a rewind, and fragile units (healers, mages) stay careful.
        const fragile = u.maxHP < 25 || u.def < 6;
        // Endgame: a few enemies (often just the boss) are left and the turns drag on, so press the attack.
        const endgame = enemies.length <= 3 && this.turn() > 12;
        const bold = lord || fragile ? 0 : endgame ? 0.6 : this.caution ? 0 : Math.min(0.6, Math.max(0, (this.turn() - 10) * 0.03));
        // Strong units (Seth, and the top two by score) lead from the front; weaker ones and
        // this chapter's new recruits hang back and keep safe.
        const front = u.charId === 0x02 || ranked.indexOf(u.charId) < 2;
        const weak = (scores.get(u.charId) ?? 1) < median;
        const newbie = !this._startIds.has(u.charId);
        const care = (1 + this.caution) * (1 - bold) * (fragile ? 1.5 : 1) * (front ? 0.7 : 1) * (weak ? 1.4 : 1) * (newbie ? 1.5 : 1);
        const penalty = (dg, hp) => {
          let pen = dg.exp * 1.5 * (1 - bold);
          // A recruiter racing to a green ally who is getting herself killed (Tana/Vanessa for Syrene) takes the risk: a death is only a rewind.
          // Frail units (L'Arachel, 19 HP) keep a margin: a square where the worst case takes 75% of their HP
          // counts as deadly, since a reinforcement or one more attacker than counted finishes them.
          if (fragile && dg.max < hp && dg.max >= hp * 0.75) pen += 120 * care;
          // Early chapters: a lord accepts a square where dying needs every enemy hit to land and that is
          // under 15% (Casim: Eirika should fight the Prologue's first Fighters; a death is only a rewind).
          if (dg.max >= hp && lord && this.chapter() < 15 && dg.pAll !== undefined && dg.pAll < 0.15) { pen += 40 + 200 * dg.pAll; return pen; }
          if (dg.max >= hp) pen += (stale && !lord && (!fragile || staleFrailToo)) || (greenRace && !lord) ? 30 : (lordCareful ? 400 : 150 * care) + (lordCareful ? 300 : 150) * care * Math.min(1, dg.exp / Math.max(1, hp)); // a square where it can die costs a lot (every death is a rewind)
          return pen;
        };
        // After a rewind, a little randomness so the retry does not repeat the same moves.
        const jitter = () => (this.caution ? Math.random() * 8 * this.caution : 0);
        const progress = -(healersNear.length || exitSpots.length || urgentTalk || stuckDoors.length || toRecruitDoor || (stale && !lord && (!fragile || staleFrailToo)) ? 12 : 3) * goalDist(t);
        // Option: seize
        if (lord && seizeKeys.has(t) && (!occ || occ === u) && !holdEnd) {
          const s = { score: 100000, unit: u, dest: tile, kind: "seize", text: `${this.uname(u)} seizes the objective` };
          if (!best || s.score > best.score) best = s;
        }
        // Only the lord can seize: everyone else keeps off the objective so it stays free.
        // ...and anyone without a key keeps off the square in front of a door, so the key holder can reach it.
        // An enemy we must recruit (Cormag) attacks on his turn and dies to the counter. Keep off squares
        // he can reach when this unit's counterattack could finish him.
        let recruitPen = 0;
        if (uw && protRed.size) for (const th of threat) {
          if (!protRed.has(th.e.charId) || !th.tiles.has(t)) continue;
          const s = this.strike(u, uw, tile, th.e, th.w, { x: tile.x + (tile.x + 1 < m.w ? 1 : -1), y: tile.y }, m);
          if (s && s.dmg * (s.doubles ? 2 : 1) >= th.e.hp) recruitPen += 500;
        }
        // ...and off the squares next to it once no enemy guards it (Seth stood in the only square in
        // front of the Chapter 14 throne for turns and Eirika could not get on it).
        const besideSeize = !lord && !seizeGuarded && seize.some((sz) => Math.abs(sz.x - tile.x) + Math.abs(sz.y - tile.y) === 1);
        // Leave the squares next to an enemy recruit to whoever is going to talk to him (Eirika stood in
        // the only square beside Rennac while L'Arachel waited behind her).
        const besideRecruit = !myTalks.length && talkable.some((e) => protRed.has(e.charId) && Math.abs(e.x - tile.x) + Math.abs(e.y - tile.y) === 1);
        const blockPen = (!lord && seizeKeys.has(t) ? 300 : 0) + (besideSeize ? 300 : 0) + (besideRecruit ? 300 : 0) + (armyHasKey && !doorKey && doorSide.has(t) ? 40 : 0) + recruitPen;
        // A sturdy unit standing guard beside a ward (Seth, Duessel, Ephraim and Dozla around Mansel and
        // Rausten) keeps that square: leaving it to attack opened the way and the wards died.
        const leavesGuard = wardGuard && !holdSq.has(t) ? 400 : 0;
        const keepHome = wards.length && (lord || (u.ranks[4] > 0 && u.items.some((i) => this.g.healStaves[i.id]))); // lords and staff healers
        const lordAway = keepHome ? Math.max(0, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y) - 3) * 300 : 0; // strong: even a potion trade does not pull the lord out (Eirika walked east for an Elixir)
        // Behind the wall (Last Hope): any action taken from outside the walled camp costs the same as moving there.
        const outsideWall = this.wallCamp && wards.length && !this.wallCamp.has(t) ? 250 + 40 * Math.min(10, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y)) : 0;
        const standAway = wards.length && this.turn() >= 8 && campAt === tA && !(u.maxHP < 25 || u.def < 6) ? Math.max(0, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y) - 2) * 60 : 0; // last stand: attacks and other actions too
        const consider = (opt) => { opt.score -= blockPen + leavesGuard + lordAway + outsideWall + standAway; if (!best || opt.score > best.score) best = opt; };
        const adj = (p) => Math.abs(p.x - tile.x) + Math.abs(p.y - tile.y) === 1;
        // Option: rescue a would-be recruit who is in trouble and carry them to their recruiter
        // (Chapter 2: Vanessa flies over the mountains, picks up Ross, brings him back to Eirika).
        if (!carrying && u.con !== undefined) for (const r of units) {
          // Any green ally who can still be recruited (even if their recruiter has not joined yet).
          if (r.side !== "green" || !recruit.has(r.charId) || recruit.get(r.charId) === u.charId || !adj(r)) continue;
          // Once per turn per unit (no passing them back and forth), and not by someone who could not carry them.
          this.rescueMarks = this.rescueMarks || new Set();
          if (this.rescueMarks.has(`${this.turn()}:${r.charId}`) || this.rescueMarks.has(`no:${u.charId}>${r.charId}`)) continue;
          if (r.hp * 2 > r.maxHP && !threat.some((th) => th.tiles.has(key(r.x, r.y)))) continue; // only when they are at risk
          consider({ score: 2500 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "rescue", target: r,
            text: `${this.uname(u)} rescues ${this.charName(r.charId)}` });
        }
        // Option: pick up a teammate who cannot fight back (an unarmed Artur) when enemies can reach them,
        // and carry them out of danger for the rest of the chapter.
        if (!carrying && !lord && uw) for (const a of blues) {
          // Who needs carrying: anyone unarmed, or a fragile fresh recruit (low level, low HP).
          const fragileRecruit = this.r8(a.addr + 8) <= 4 && a.maxHP < 25 && !this._startIds.has(a.charId);
          // A badly hurt lord in reach of enemies is carried too: her death is a rewind every time.
          const hurtLord = false; // carrying the lord left her stranded next to the enemy (Chapter 12), so she moves herself
          // A frail unit inside a long-range caster's reach (Amelia vs Purge) is carried out of it.
          const frailInSiege = !this.g.lordIds.includes(a.charId) && inSiege(a.x, a.y) && (a.maxHP < 22 || a.hp < 12);
          // ...and anyone put to sleep by an enemy staff (they cannot move themselves).
          const asleep = this.cannotAct(a);
          if (a === u || !adj(a) || ((this.weaponOf(a) || a.items.some((i) => this.g.healStaves[i.id])) && !fragileRecruit && !hurtLord && !frailInSiege && !asleep)) continue;
          if (!hurtLord && !frailInSiege && !asleep && (frontUnits.includes(a) || convoyHas(a))) continue; // front-liners re-arm instead of being carried
          if (frontUnits.includes(u)) continue;                  // the front line keeps its hands free
          if (!threat.some((th) => th.tiles.has(key(a.x, a.y)))) continue;
          this.rescueMarks = this.rescueMarks || new Set();
          if (this.rescueMarks.has(`${this.turn()}:${a.charId}`) || this.rescueMarks.has(`no:${u.charId}>${a.charId}`)) continue;
          // The carrier must not be standing somewhere it can die: if it falls, its passenger is
          // dropped right there (Ross at 3 HP died with his carrier in Chapter 12).
          const cdg = danger(null);
          if (cdg.max >= u.hp) continue;
          // Carrying someone halves the carrier's Speed and Skill, which the danger estimate does not see,
          // so only pick someone up from a square no enemy can reach (Tana carrying Artur, and Cormag at
          // 6 HP, both died on the next enemy turn in Hamill Canyon). A sleeping unit is the exception.
          // A sturdy carrier (Seth, Dozla) may still take a frail fresh recruit (Amelia kept dying on turns
          // 8-9 of Hamill Canyon) from a square where nothing can bring it near death.
          const sturdy = u.maxHP >= 35 && u.def >= 9 && cdg.max * 1.5 < u.hp;
          if (cdg.exp > 0 && !asleep && !(fragileRecruit && sturdy)) continue;
          consider({ score: (asleep ? 1200 : 700) - penalty(cdg, u.hp) * (asleep ? 0.5 : 1), unit: u, dest: tile, kind: "rescue", target: a,
            text: `${this.uname(u)} picks up ${this.uname(a)} to keep them safe` });
        }
        // A teammate carried to safety is set down again once the carrier stands somewhere no enemy can
        // reach (Vanessa carried someone away from the fight in Village of Silence and never let go, so
        // the last Mogall, which only fliers can reach, was never attacked).
        if (carrying && carried && carried.side === "blue" && danger(null).exp === 0) {
          let drop = null;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const x = tile.x + dx, y = tile.y + dy;
            if (x < 0 || y < 0 || x >= m.w || y >= m.h || occupied.has(key(x, y)) || this.s8(this.costTable(carried) + m.t[y][x]) < 0) continue;
            if (threat.some((th) => th.tiles.has(key(x, y)))) continue;
            drop = { x, y }; break;
          }
          if (drop) consider({ score: 400 + jitter(), unit: u, dest: tile, kind: "drop", targetXY: drop,
            text: `${this.uname(u)} sets ${this.uname(carried)} down out of reach` });
        }
        if (carrying && carried && carried.side !== "blue") {
          // Bring them to their recruiter, or to the lord if the recruiter has not joined yet.
          const talker = blues.find((b) => b.charId === recruit.get(carried.charId)) || blues.find((b) => this.g.lordIds.includes(b.charId));
          if (talker) {
            const dT = Math.abs(talker.x - tile.x) + Math.abs(talker.y - tile.y);
            // Drop the passenger on a free square next to the carrier, as close to the recruiter as possible.
            let drop = null, bd = 1e9;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const x = tile.x + dx, y = tile.y + dy;
              if (x < 0 || y < 0 || x >= m.w || y >= m.h || occupied.has(key(x, y)) || this.s8(this.costTable(carried) + m.t[y][x]) < 0) continue;
              const d = Math.abs(talker.x - x) + Math.abs(talker.y - y);
              if (d < bd) { bd = d; drop = { x, y }; }
            }
            if (drop && bd <= talker.mov) {
              this.rescueMarks = this.rescueMarks || new Set(); // dropped this turn: leave them be
              this.rescueMarks.add(`${this.turn()}:${carried.charId}`);
              consider({ score: 2400 - bd * 10 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "drop", targetXY: drop,
                text: `${this.uname(u)} drops ${this.charName(carried.charId)} off near ${this.uname(talker)}` });
            } else {
              consider({ score: 1500 - dT * 20 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "move",
                text: `${this.uname(u)} carries ${this.charName(carried.charId)} back` });
            }
          }
        }
        // Option: talk to a recruitable enemy (they join the army)
        for (const e of myTalks) if (adj(e)) {
          // A lord does not talk from a square where she could die, unless the recruit has been on the
          // map for 4+ turns and time may be running out (Eirika talked Cormag round on turn 5-6 of
          // Hamill Canyon from deadly squares and died on the enemy turn, again and again).
          const tdg = danger(e), tk = `${this.chapter()}:${u.charId}>${e.charId}`;
          if (lord && tdg.max >= u.hp && this.turn() - (this.talkSince.get(tk) ?? this.turn()) < 4) continue;
          consider({ score: 3000 - penalty(tdg, u.hp), unit: u, dest: tile, kind: "talk", target: e, // the one we talk to joins, so he is no threat
            text: `${this.uname(u)} talks to ${this.charName(e.charId)}` });
        }
        // Option: break a cracked wall or snag that is in weapon range
        // (Scored on the same scale as moving: with progress scaled down, a far goal made breaking any
        // nearby wall look better than heading for it; Tana and Vanessa broke a wall on turn 1 of River
        // of Regrets instead of flying to Syrene.)
        if (uw && !greenRace) for (const w of breakable) {
          const d = Math.abs(w.x - tile.x) + Math.abs(w.y - tile.y);
          if (d < uw.min || d > uw.max) continue;
          consider({ score: 18 + progress - penalty(danger(null), u.hp) + jitter(), unit: u, dest: tile, kind: "attack",
            targetXY: w, text: `${this.uname(u)} breaks the wall at ${w.x},${w.y}` });
        }
        // Option: open a door with a key or lockpick
        if (doorKey) for (const dr of doors) if (adj(dr)) {
          const lordWaits = blues.some((b) => this.g.lordIds.includes(b.charId) && Math.abs(b.x - dr.x) + Math.abs(b.y - dr.y) <= 3);
          // A recruit's door waits for his talker even if a lord stands nearby (Colm opened Rennac's door
          // with Eirika close but L'Arachel far to the south, and Rennac got away).
          if (recruitDoors.includes(dr) && !talkerNear()) continue;
          consider({ score: (stuckDoors.includes(dr) ? 2500 : 40) - penalty(danger(null), u.hp) + jitter(), unit: u, dest: tile, kind: "door", targetXY: dr,
            text: `${this.uname(u)} opens the door at ${dr.x},${dr.y}` });
        }
        // Option: an unarmed unit next to the lord (or the lord) takes a weapon from the convoy.
        if (!uw && canWield && roomFor && convoyHas(u)) {
          const lordU = blues.find((b) => b.charId === (this.route === "ephraim" ? 0x0F : 0x01)) || blues.find((b) => this.g.lordIds.includes(b.charId));
          if (lordU && (lordU === u || adj(lordU))) {
            consider({ score: (u.charId === 0x02 ? 950 : 350) - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "supply",
              text: `${this.uname(u)} takes a weapon from the convoy` });
          }
        }
        // Option: a badly hurt unit with nothing to heal with takes a Vulnerary or Elixir from a
        // neighbour (trading does not use up the turn) and drinks it at once. The lord first.
        if (u.hp * 2 < u.maxHP && !vul && roomFor) for (const a of blues) {
          if (a === u || !adj(a)) continue;
          const potion = a.items.find((i) => i.id === this.g.vulnerary || i.id === 0x6D);
          if (!potion) continue;
          consider({ score: (lord ? 1200 : 300) + (u.maxHP - u.hp) * 3 - penalty(danger(null), u.hp + 15), unit: u, dest: tile, kind: "trade", target: a,
            partnerSlot: potion.slot, unitItems: u.items.length < 5 ? u.items.length : this.junkSlot(u), healAfter: true,
            text: `${this.uname(u)} takes ${this.aOrAn(this.text(this.r16(this.g.itemData + potion.id * this.g.itemSize)))} from ${this.uname(a)}` });
        }
        // Option: a healer with no staff takes one from a neighbour who cannot use it (Forde ended up
        // carrying L'Arachel's Mend while she, Moulder and Natasha had none).
        if (u.ranks[4] && !u.items.some((i) => this.g.healStaves[i.id]) && roomFor) for (const a of blues) {
          if (a === u || !adj(a) || a.ranks[4]) continue;
          const st = a.items.find((i) => this.g.healStaves[i.id] && !(this.item(i.id).rank && u.ranks[4] < this.item(i.id).rank));
          if (!st) continue;
          consider({ score: 500 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "trade", target: a,
            partnerSlot: st.slot, unitItems: u.items.length < 5 ? u.items.length : this.junkSlot(u),
            text: `${this.uname(u)} takes ${this.aOrAn(this.text(this.r16(this.g.itemData + st.id * this.g.itemSize)))} back from ${this.uname(a)}` });
        }
        // Option: take a promotion item that fits from a neighbour (it gets used right after).
        for (const a of promoDonors) if (adj(a)) {
          const it = a.items.find((i) => this.g.promoItems.includes(i.id) && fits(i.id));
          if (!it) continue;
          consider({ score: 600 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "trade", target: a,
            partnerSlot: it.slot, unitItems: u.items.length < 5 ? u.items.length : this.junkSlot(u),
            text: `${this.uname(u)} takes ${this.aOrAn(this.text(this.r16(this.g.itemData + it.id * this.g.itemSize)))} from ${this.uname(a)} to promote` });
        }
        // Option: an unarmed unit (Seth above all) takes a spare weapon from a neighbour.
        if (!uw && canWield && roomFor) for (const a of blues) {
          if (a === u || !adj(a)) continue;
          const theirs = this.weaponsOf(a).map((w) => w.slot);
          const give = a.items.find((i) => {
            const d = this.item(i.id);
            if (!(d.attr & 1) || d.type > 7 || d.type === 4 || (d.rank && u.ranks[d.type] < d.rank) || !u.ranks[d.type]) return false;
            return !theirs.includes(i.slot) || theirs.length > 1; // they cannot use it, or they have another
          });
          if (!give) continue;
          consider({ score: (u.charId === 0x02 ? 900 : 300) - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "trade", target: a,
            partnerSlot: give.slot, unitItems: u.items.length < 5 ? u.items.length : this.junkSlot(u),
            text: `${this.uname(u)} takes ${this.aOrAn(this.text(this.r16(this.g.itemData + give.id * this.g.itemSize)))} from ${this.uname(a)}` });
        }
        // Option: shop for a weapon on an armory tile
        if (needsWeapon && m.t[tile.y][tile.x] === T.armory) {
          consider({ score: (uw ? 60 : 200) - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "shop",
            text: `${this.uname(u)} goes shopping for a weapon` });
        }
        // Option: buy a staff or a Vulnerary on a vendor tile
        if (needsItem && m.t[tile.y][tile.x] === T.vendor) {
          consider({ score: 150 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "vendor",
            text: `${this.uname(u)} goes to the vendor for ${u.ranks[4] > 0 && !hasStaffV ? "a staff" : "a Vulnerary"}` });
        }
        // Option: open a chest it is standing on
        if (chestKey && m.t[tile.y][tile.x] === T.chest) {
          consider({ score: 45 - penalty(danger(null), u.hp) + jitter(), unit: u, dest: tile, kind: "chest",
            text: `${this.uname(u)} opens a chest` });
        }
        // Option: heal a hurt ally with a staff (healers otherwise never act)
        for (const it of u.items) {
          const amt = this.g.healStaves[it.id]; if (!amt) continue;
          const sd = this.item(it.id);
          if (sd.rank && u.ranks[4] < sd.rank) continue;
          const maxR = it.id === 0x4E ? Math.max(1, u.pow >> 1) : Math.max(1, sd.max);
          // Heal teammates and green allies we are trying to keep alive (Gerik, Tethys...).
          // ...and any green ally standing right next to a ward: the General beside Mansel is his west wall,
          // and when he died an enemy Mage Knight took that square and killed Mansel (Last Hope, turn 9-10).
          const wallGreens = units.filter((g) => g.side === "green" && !wards.includes(g) && wards.some((w) => Math.abs(w.x - g.x) + Math.abs(w.y - g.y) === 1));
          for (const a of blues.concat(units.filter((g) => g.side === "green" && (recruit.has(g.charId) || wards.includes(g))), wallGreens)) { // and the wards on a Survive map
            if (a === u || a.hp >= a.maxHP - 3) continue;
            const d = Math.abs(a.x - tile.x) + Math.abs(a.y - tile.y);
            if (d < 1 || d > maxR) continue;
            // A healer does not heal from a square where it can die, unless it is saving the lord.
            // (Only a lord below a third of his HP: at half, Natasha kept healing Eirika from squares in a
            // Swordmaster's reach in Last Hope and dying for it.)
            { const hdg = danger(null); if (hdg.max >= u.hp && !(this.g.lordIds.includes(a.charId) && a.hp * 3 < a.maxHP)) continue; }
            const onLava = this.hazardTerrain && this.hazardTerrain.has(m.t[a.y][a.x]) && a.hp <= 20; // the lava takes 10 more next turn
            const gain = Math.min(amt, a.maxHP - a.hp) + ((this.g.lordIds.includes(a.charId) || wards.includes(a)) && a.hp * 2 < a.maxHP ? 60 : 0) + (wallGreens.includes(a) && a.hp * 5 < a.maxHP * 3 ? 45 : 0) + (onLava ? 40 : 0); // the lord (and the wards we defend) first, by a wide margin
            consider({ score: 15 + gain * 4 + (a.hp * 3 < a.maxHP ? 30 : 0) - penalty(danger(null), u.hp) + jitter(), unit: u, dest: tile,
              kind: "staff", target: a, text: `${this.uname(u)} heals ${this.uname(a)}` });
          }
          break; // first usable healing staff only
        }
        // Option: attack each enemy in range from here
        // While camping, only fight from squares in or at the edge of the camp.
        // (An early lord may step out of the camp to fight: the camp kept Eirika behind the wall while the
        // Prologue's Fighters came to Seth, and she never got their experience.)
        const outOfCamp = camping && !(lord && this.chapter() < 15 && !this.wallCamp) && Math.abs(tile.x - campAt.x) + Math.abs(tile.y - campAt.y) > campR + 1;
        if (uw && !outOfCamp) for (const e of enemies) for (const w of this.weaponsOf(u)) {
          // Try every weapon: a Longbow from 3 squares can hit a mage who cannot hit back.
          if (holdEnd && ((goal === 1 && enemies.length === 1) || (goal === 3 && (this.r32(e.charPtr + 0x28) & 0x8000)))) continue;
          const res = this.combat(u, w, tile, e, this.weaponOf(e), { x: e.x, y: e.y }, m);
          if (!res) continue;
          // Early on Seth does not take a likely kill at all (unless a teammate is about to die to that
          // enemy): a penalty was not enough, he still doubled and killed the Prologue's first Fighter.
          if (u.charId === 0x02 && this.chapter() < 9 && res.pKill >= 0.5 && !blues.some((a) => a !== u && a.hp * 5 <= a.maxHP * 2 && threat.find((th) => th.e === e)?.tiles.has(key(a.x, a.y)))) continue;
          if (lord && res.pKill < 0.5 && res.pDie > (this.chapter() < 15 ? 0.15 : 0.03)) continue; // the lord never gambles on a poor attack (early on, up to 15% risk: Casim)
          if (weakU && !(lord && this.chapter() < 15 && res.pDie < 0.15) && res.pKill < 0.3 && res.pDie > 0.05) continue; // nor do weak units (Amelia poking a Warrior); an early lord follows the 15% rule
          const dg = danger(res.pKill > 0.6 ? e : null);
          const hpAfter = Math.max(1, u.hp - res.expTaken);
          // In the endgame every point of damage on the last enemies is progress (several units can finish a boss).
          const chip = endgame ? 150 * res.expDealt / Math.max(1, e.hp) : 0;
          // Killing an enemy who can reach a would-be recruit protects them.
          const guard = greenRecruits.some((g) => threat.find((th) => th.e === e)?.tiles.has(key(g.x, g.y))) ? 80 * res.pKill + 1.5 * res.expDealt : 0;
          // A long-range caster (siege tomes reach 3-10 squares) hurts the whole army every turn: take it out first.
          const ew = this.weaponOf(e), siege = ew && ew.max >= 3 && ew.type >= 5 && ew.type <= 7 && frontUnits.includes(u) ? 150 * res.pKill + 3 * res.expDealt : 0;
          // Enemies carrying Sleep or Berserk staves put our units out of action: take them out early.
          const staffer = e.items.some((i) => i.id === 0x52 || i.id === 0x53) ? 100 * res.pKill + 2 * res.expDealt : 0;
          // A teammate down to his last few HP who this enemy can reach (Seth at 1 HP, cornered by two
          // Rangers): killing it is the only way he lives, so it outranks this unit's own caution.
          const rescue = blues.concat(wards).some((a) => a !== u && (a.hp * 5 <= a.maxHP || wards.includes(a)) && threat.find((th) => th.e === e)?.tiles.has(key(a.x, a.y))) ? 200 * res.pKill + 2 * res.expDealt : 0; // and anyone threatening a ward
          // Early on Seth softens enemies and leaves the kill (and its experience) to the others, Eirika
          // above all (Casim: in the Prologue Seth took the easy kills and Eirika stayed weak). The lord
          // takes a kill she can make without real risk.
          const jagen = u.charId === 0x02 && this.chapter() < 9;
          const jagenKill = jagen && !rescue ? 230 * res.pKill : 0; // outweighs the kill itself, so a chip hit wins
          // (Under 15% risk, Casim's call: a lord who never risks a counterattack never levels, and a
          // death is only a rewind.)
          // ...and fights at all when it is that safe, kill or not: the experience is the point
          // (Eirika should take the Prologue's first Fighters herself).
          const lordFeed = lord && res.pDie < 0.15 && this.chapter() < 15 ? 90 * res.pKill + 80 : 0;
          const score = 120 * res.pKill + 2.5 * res.expDealt + chip + guard + siege + staffer + rescue - (greenRace ? 250 : 0) - leavesGuard - outsideWall - standAway - jagenKill + lordFeed - (lord && wards.length ? Math.max(0, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y) - 3) * 15 : 0) - (lord ? (res.pDie < 0.15 ? 200 : 600) : endgame ? 80 : 200) * care * res.pDie - 1.2 * res.expTaken // greenRace: no detours while racing to a green recruit; leavesGuard: guards beside a ward stay put
            - penalty(dg, hpAfter) + progress * 0.3 + 5 + jitter() - blockPen
            // A unit left below 60% by the counter, on a square where the enemy phase can finish it, does
            // not make that attack (Gerik kept attacking a Hero from the north-west doorway of Last Hope).
            - (hpAfter < u.maxHP * 0.6 && dg.max >= hpAfter ? (res.pKill >= 0.9 ? 150 : 700) : 0); // (stronger unless the kill is near-certain: Gerik at 17 HP still attacked the Hero at 3,5, left it at 12 and died to it)
          if (this.dbgOpts) this.dbgOpts.push([this.uname(u), tile.x, tile.y, this.uname(e), Math.round(score), +res.pKill.toFixed(2), +res.pDie.toFixed(2), Math.round(chip)]);
          if (!best || score > best.score) {
            best = { score, unit: u, dest: tile, kind: "attack", target: e, weaponSlot: w.slot,
              text: `${this.uname(u)} attacks ${this.uname(e)} with ${this.text(this.r16(this.g.itemData + w.id * this.g.itemSize)) || "a weapon"} (kill chance ${Math.round(res.pKill * 100)}%)` };
          }
        }
        // Option: promote with a crest or seal once level 10 or higher
        if (promo && t === key(u.x, u.y)) {
          consider({ score: 400 - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "promote", slot: promo.slot, itemId: promo.id,
            text: `${this.uname(u)} promotes with ${this.aOrAn(this.text(this.r16(this.g.itemData + promo.id * this.g.itemSize)))}` });
        }
        // Option (a Dancer, Tethys): dance for a strong neighbour that has already acted, so it acts again.
        // Only from a square no enemy can reach: Tethys has 18 HP and kept dying beside the units she danced for.
        if (/Dancer|Bard/.test(this.text(this.r16(u.classPtr))) && danger(null).max === 0) {
          for (const a of blues) {
            if (a === u || Math.abs(a.x - tile.x) + Math.abs(a.y - tile.y) !== 1 || !(this.r32(a.addr + 0x0C) & 0x2)) continue;
            const worth = a.maxHP + 2 * a.pow + (this.g.lordIds.includes(a.charId) ? 0 : 20);
            consider({ score: 200 + worth - penalty(danger(null), u.hp), unit: u, dest: tile, kind: "dance", target: a,
              text: `${this.uname(u)} dances for ${this.uname(a)}` });
          }
        }
        // Option: use a stat booster it carries (Swiftsole, Energy Ring, Dracoshield...): Casim wants
        // them used rather than carried around. Done from a safe square, early in the turn.
        const booster = u.items.find((i) => this.isBooster(i.id));
        if (booster) {
          const dg = danger(null);
          const score = 260 - penalty(dg, u.hp) + progress * 0.2 - blockPen;
          if (!best || score > best.score) best = { score, unit: u, dest: tile, kind: "heal", slot: booster.slot,
            text: `${this.uname(u)} uses ${this.aOrAn(this.text(this.r16(this.g.itemData + booster.id * this.g.itemSize)))}` };
        }
        // Option: heal with a Vulnerary when hurt
        if (vul && u.hp * 2 <= u.maxHP) {
          const dg = danger(null);
          const score = 40 + (u.maxHP - u.hp) * 3 - penalty(dg, Math.min(u.maxHP, u.hp + 10)) + progress * 0.2 - blockPen;
          if (!best || score > best.score) best = { score, unit: u, dest: tile, kind: "heal", slot: vul.slot, text: `${this.uname(u)} uses ${vul.id === 0x6D ? "an Elixir" : "a Vulnerary"}` };
        }
        // Option: move (toward the goal, or to safety) and wait
        const dg = danger(null);
        // Weak units stay close behind the front line (Seth, the strongest units) instead of
        // spreading out where fliers can pick them off.
        let huddle = 0;
        if (weakU && frontUnits.length && !lord && enemies.length && !urgentTalk && !stuckDoors.length && !toRecruitDoor) { // not the lord (she must reach the objective), not once the map is clear, not on a recruit talk or a door errand
          const d = Math.min(...frontUnits.filter((f) => f !== u).map((f) => Math.abs(f.x - tile.x) + Math.abs(f.y - tile.y)));
          if (Number.isFinite(d)) huddle = 6 * Math.max(0, d - 2);
        }
        // Hurt or weak units get out of a long-range caster's reach; the strong ones go in after him.
        // Squares near where reinforcements appeared before are risky for the hurt and for the lord.
        const spawnD = (this.spawnPts || []).reduce((mn, p) => Math.min(mn, Math.abs(p[0] - tile.x) + Math.abs(p[1] - tile.y)), 99);
        const nearSpawn = spawnD <= 6;
        // Not once the map is clear, and never on the objective or the squares beside it: in Queen of White
        // Dunes the throne room had seen reinforcements, so Eirika walked back and forth near it for
        // 100 turns with every enemy already dead.
        const nearSeize = seize.some((sz) => Math.abs(sz.x - tile.x) + Math.abs(sz.y - tile.y) <= 1);
        // Graded by distance (closer is worse): Last Hope has reinforcements arriving from many places, and
        // a flat penalty made every square equal, so Moulder and Natasha stood next to an arrival point.
        const spawnPen = nearSpawn && enemies.length && !nearSeize && (lord || fragile || u.hp < u.maxHP * 0.6) ? (lord ? 250 : 150) * (7 - spawnD) / 4 : 0; // frail ones too (L'Arachel, Amelia)
        const siegePen = siegeCasters.length && !frontUnits.includes(u) && (weakU || u.hp < u.maxHP * 0.7) && inSiege(tile.x, tile.y) ? 150 : 0;
        // The lord keeps within a few squares of a staff healer while enemies are about (Eirika kept
        // ending up alone at the far end of Hamill Canyon, hurt, with both healers out of reach).
        let lordLeash = 0;
        if (lord && enemies.length) {
          const hs = blues.filter((b) => b !== u && b.items.some((i) => this.g.healStaves[i.id]));
          if (hs.length) lordLeash = Math.max(0, Math.min(...hs.map((b) => Math.abs(b.x - tile.x) + Math.abs(b.y - tile.y))) - 3) * 8;
        }
        // (Staff healers never hold a wall square: Saleh kept dying holding the west entrance of Last Hope.)
        const sturdyU = (frontUnits.includes(u) || (u.maxHP >= 30 && u.def >= 8)) && !fragile && !(u.ranks[4] > 0 && u.items.some((i) => this.g.healStaves[i.id]));
        // Last stand (Survive map with a ward, from turn 8): by then reinforcements have piled into the throne
        // room (turn 10 of Last Hope: Mansel at 5 HP with a Warrior and three Swordmasters beside him while
        // most of the army was spread out east). Everyone of the main group closes in around the ward and
        // any unit that is not frail fills the squares next to him.
        const lastStand = wards.length && this.turn() >= 8 && campAt === tA && !fragile; // not the frail: pulled in, Tethys died on turn 9 again and again
        const walled = !!(this.wallCamp && wards.length);
        const outside = walled && !this.wallCamp.has(t) ? 250 + 40 * Math.min(10, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y)) : 0; // stay behind the wall
        const standPen = lastStand ? Math.max(0, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y) - 2) * 60 - (guardSq.has(t) && !fragile ? 120 : 0) : 0;
        const chokeBonus = -standPen + (walled
          // An empty wall square is worth filling even by a unit that is not quite sturdy (only the frail
          // and healers stay off): a hole lets the enemy in to the wards, as at 11,10 and 15,15 in Last Hope.
          ? (doorways.has(t) ? (sturdyU ? 160 : (!fragile && !(u.ranks[4] > 0 && u.items.some((i) => this.g.healStaves[i.id])) ? 90 : -120)) : 0) - outside
          : (camping && doorways.size ? (doorways.has(t) ? (sturdyU ? 40 : -40) : 0) : 0) + (guardSq.has(t) && sturdyU ? 70 : 0) + (guardRing.has(t) && sturdyU ? 35 : 0));
        // On a Survive map with wards, the lords stay inside the defended area (Eirika drifted to the
        // east edge of Last Hope alone and was cut down to 8 HP in one enemy phase).
        const lordHome = keepHome ? Math.max(0, Math.abs(tile.x - tA.x) + Math.abs(tile.y - tA.y) - 3) * (lord ? 120 : 15) : 0; // the lord strongly (Eirika walked out to 20,14 in Last Hope and was cut down)
        // Hurt (below 60%) and on a square enemies can reach: step back and let a healthier unit hold it.
        const hurtFront = u.hp < u.maxHP * 0.6 && dg.max > 0 ? 40 + 60 * Math.min(1, dg.max / Math.max(1, u.hp)) : 0;
        const score = progress - penalty(dg, u.hp) + (t === key(u.x, u.y) ? 0.5 : 0) + jitter() - blockPen - huddle - siegePen - spawnPen - lordLeash + chokeBonus - leavesGuard - lordHome - hurtFront;
        if (this.dbgMoves) this.dbgMoves.push([this.uname(u), tile.x, tile.y, Math.round(score), Math.round(progress), Math.round(penalty(dg, u.hp)), blockPen, Math.round(dg.exp), dg.max, threat.filter((th) => th.tiles.has(t)).map((th) => this.uname(th.e)).join(",")]);
        if (!best || score > best.score) {
          const toward = lord && seize.length ? "the objective" : "the enemy";
          best = { score, unit: u, dest: tile, kind: "move", text: dg.exp > 0 ? `${this.uname(u)} moves to a safer tile` : `${this.uname(u)} moves toward ${toward}` };
        }
      }
    }
    return best;
  }
  uname(u) {
    const charName = this.text(this.r16(u.charPtr));
    if (u.side === "blue") return charName || "A unit";
    const boss = (this.r32(u.charPtr + 0x28) & 0x8000) !== 0; // boss attribute
    if (boss && charName) return charName;
    const cls = this.text(this.r16(u.classPtr));
    return cls ? `the ${cls} at ${u.x},${u.y}` : `the enemy at ${u.x},${u.y}`;
  }
}
