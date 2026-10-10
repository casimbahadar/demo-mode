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
    },
    idle: { mainIdle: 0x0801C941, rangeIdle: 0x0801CD1D },
    chapterData: 0x0202BCF0, cursor: 0x0202BCC4, activeUnit: 0x03004E50,
    units: { blue: [0x0202BE4C, 62], red: [0x0202CFBC, 50], green: [0x0202DDCC, 20] },
    mapSize: 0x0202E4D4, mapTerrain: 0x0202E4DC,
    itemData: 0x08809B10, itemSize: 36,
    lordIds: [0x01, 0x0F], // Eirika, Ephraim
    msg: { seize: 0x67A, attack: 0x67B, item: 0x68D, wait: 0x695, end: 0x6A0, use: 0x696 },
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
  }
  static supports(code) { return !!FE_GAMES[code]; }

  say(text) {
    if (text !== this.status) {
      this.status = text;
      this.log.push(`[${this.ws.frame}] ${text}`);
      if (this.log.length > 300) this.log.shift();
    }
  }

  // Called after every emulated frame.
  step() {
    if (!this.enabled) return;
    if (!this.ws.memReady()) {
      if (this.ws.frame < 30 || this.ws.frame % 30) return;
      if (!this.ws.locateMemory()) return;
    }
    if (this.wait > 0) { this.wait--; return; }
    if (!this.gen) this.gen = this.main();
    try {
      const r = this.gen.next();
      if (r.done) this.gen = null;
      else this.wait = Math.max(0, (r.value | 0) - 1);
    } catch (e) {
      this.say("Bot error, restarting: " + e.message);
      console.error(e);
      this.ws.releaseAll();
      this.gen = null; this.intent = null; this.wait = 10;
    }
  }
  reset() { this.ws.releaseAll(); this.gen = null; this.intent = null; this.wait = 6; }

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
  chapter() { return this.r8(this.g.chapterData + 0x0E); }
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
      if (!(d.attr & 1) || d.type > 7 || d.type === 4) continue; // weapons only, no staves
      if (d.rank && u.ranks[d.type] < d.rank) continue;
      if (d.attr & 0x10000) continue; // locked weapons are rare; skip to be safe
      return d;
    }
    return null;
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
    const diff = has(P.difficulty);
    if (diff) return { kind: "difficulty", proc: diff, ps };
    if (target) return { kind: "target", proc: target, ps };
    if (menu) return { kind: "menu", proc: menu, ps };
    if (has(P.textChoice)) return { kind: "choice", ps };
    // Battles first: battle quotes use the event engine too, and Start must not be pressed there.
    if (has(P.ekrBattle) || has(P.battle) || has(P.battleEvent)) return { kind: "battle", talking: !!has(P.dialogue), ps };
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
        case "choice": this.say("Answering a question"); yield* this.press("A", 2, 20); break;
        case "event":
          // A map cutscene: Start skips the whole scene; A clears any text box left over.
          this.say("Skipping a cutscene");
          if (this.ws.frame - this.lastSceneChange < 8) { yield 2; break; } // let it settle first
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
          otherCount++;
          this.say("Moving through menus");
          yield* this.press(otherCount % 4 === 0 ? "START" : "A", 2, 24);
      }
    }
  }

  *playerFree() {
    const units = this.units();
    const mine = units.filter((u) => u.side === "blue");
    const ready = mine.filter((u) => !(u.state & US_UNSELECTABLE));
    if (this.intent && this.intent.stage === "done") {
      if (this.onAction) this.onAction(this.intent);
      this.intent = null;
    }
    if (!ready.length) { yield* this.endTurn(units); return; }
    const plan = this.plan(units, ready);
    this.intent = { ...plan, stage: "select" };
    this.say(plan.text);
    const u = plan.unit;
    if (!(yield* this.moveCursor(u.x, u.y, "free"))) return;
    yield* this.press("A", 2, 6);
    const ok = yield* this.waitFor(() => { const k = this.scene().kind; return k === "moveSelect" || k === "menu"; }, 60);
    if (ok) this.intent.stage = "move";
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
      if (!(yield* this.moveCursor(it.dest.x, it.dest.y, "moveSelect"))) return;
      yield* this.press("A", 2, 6);
      const ok = yield* this.waitFor(() => this.scene().kind === "menu", 240);
      if (ok) it.stage = "act";
      else { this.say("Could not move there, choosing again"); yield* this.press("B", 2, 10); this.intent = null; }
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
    const idx = (id) => m.items.findIndex((i) => i.msg === id);
    const it = this.intent;
    if (idx(msg.wait) >= 0) {               // the unit's action menu
      if (it && it.stage === "move") {
        // The menu opened before the unit moved (it happens on the first selection of a map).
        yield* this.press("B", 2, 12); this.intent = null; return;
      }
      if (!it || it.stage !== "act") {
        yield* this.pickMenu(menu, idx(msg.wait)); if (this.intent) this.intent.stage = "done"; return;
      }
      let want = msg.wait;
      if (it.kind === "seize" && idx(msg.seize) >= 0) want = msg.seize;
      else if (it.kind === "attack" && idx(msg.attack) >= 0) want = msg.attack;
      else if (it.kind === "heal" && idx(msg.item) >= 0) want = msg.item;
      if (want === msg.wait && it.kind !== "wait" && it.kind !== "move") this.say(`${it.text} (not possible here, waiting)`);
      it.stage = want === msg.attack ? "weapon" : want === msg.item ? "itemList" : "done";
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
    if (it && it.stage === "weapon") { it.stage = "target"; yield* this.press("A", 2, 10); return; }
    if (it && it.stage === "itemList") {
      const row = m.items.findIndex((i) => i.number === it.slot);
      it.stage = "itemSub";
      yield* this.pickMenu(menu, row >= 0 ? row : 0);
      return;
    }
    // Any other menu (yes/no prompts, chapter-end screens): take the first choice.
    this.say("Confirming a menu");
    yield* this.press("A", 2, 14);
  }

  *onTarget(proc) {
    const it = this.intent;
    const cur = () => { const t = this.r32(proc.addr + 0x30); return t ? this.s8(t + 2) & 0xFF : -1; };
    if (it && it.stage === "target" && it.target) {
      const uid = it.target.index;
      for (let k = 0; k < 12 && cur() !== uid; k++) yield* this.press("RIGHT", 2, 6);
      if (cur() !== uid) this.say("Target not in reach, taking the nearest");
      it.stage = "done";
      yield* this.press("A", 2, 10);
      return;
    }
    yield* this.press("A", 2, 10);
  }

  // ---- Planning ------------------------------------------------------------------------
  costTable(u) { return this.r32(u.classPtr + 0x38); }
  terrainBonus(u, terr, off) { const p = this.r32(u.classPtr + off); return p ? this.s8(p + terr) : 0; }

  reach(u, m, blocked, maxCost) {
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
        const step = this.s8(ct + m.t[ny][nx]);
        if (step < 0) continue;
        const nc = c + step;
        if (nc > maxCost) continue;
        if (nc < (cost.get(k) ?? 1e9)) { cost.set(k, nc); open.push([nc, nx, ny]); }
      }
    }
    return cost;
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
    const magic = aw.type >= 5 && aw.type <= 7;
    const tri = FEBot.triangle(aw ? aw.type : -1, dw ? dw.type : -1);
    const terr = m.t[dTile.y][dTile.x];
    const eff = aw.eff.includes(d.classId) ? 3 : 1;
    const dmg = Math.max(0, a.pow + aw.might * eff + tri - (magic ? d.res : d.def) - this.terrainBonus(d, terr, magic ? 0x4C : 0x48));
    const as = (u, w) => u.spd - Math.max(0, (w ? w.wt : 0) - u.con);
    const hit = Math.max(0, Math.min(100, aw.hit + a.skl * 2 + (a.lck >> 1) + tri * 15
      - (as(d, dw) * 2 + d.lck + this.terrainBonus(d, terr, 0x44))));
    return { dmg, p: this.trueHit[hit], hit, doubles: as(a, aw) - as(d, dw) >= 4 };
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
    const enemies = units.filter((u) => u.side === "red");
    const blues = units.filter((u) => u.side === "blue");
    const notRed = units.filter((u) => u.side !== "red");
    const occupied = new Map(units.map((u) => [key(u.x, u.y), u]));
    const seize = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (this.g.seizeTerrains.includes(m.t[y][x])) seize.push({ x, y });
    const seizeKeys = new Set(seize.map((s) => key(s.x, s.y)));

    // Where each enemy could strike next enemy phase (player units block their paths).
    const blockForRed = new Set(notRed.map((u) => key(u.x, u.y)));
    const threat = enemies.map((e) => {
      const w = this.weaponOf(e);
      if (!w) return { e, w, tiles: new Set() };
      const stays = seizeKeys.has(key(e.x, e.y)); // bosses on thrones and gates hold position
      const r = stays ? new Map([[key(e.x, e.y), 0]]) : this.reach(e, m, blockForRed, e.mov);
      const tiles = new Set();
      for (const k of r.keys()) {
        const ex = k % 64, ey = (k / 64) | 0;
        for (let dy = -w.max; dy <= w.max; dy++) for (let dx = -w.max; dx <= w.max; dx++) {
          const dd = Math.abs(dx) + Math.abs(dy);
          if (dd < w.min || dd > w.max) continue;
          tiles.add(key(ex + dx, ey + dy));
        }
      }
      return { e, w, tiles };
    });

    let best = null;
    for (const u of ready) {
      const uw = this.weaponOf(u);
      const lord = this.g.lordIds.includes(u.charId);
      const blockForBlue = new Set(enemies.map((e) => key(e.x, e.y)));
      const r = this.reach(u, m, blockForBlue, u.mov);
      // Distance-to-goal field (ignoring units) for moving forward.
      const far = this.reach(u, m, new Set(), 999);
      const goals = lord && seize.length ? seize : enemies.map((e) => ({ x: e.x, y: e.y }));
      const goalDist = (t) => {
        if (!goals.length) return 0;
        let bd = 1e9;
        for (const gl of goals) {
          // approximate path distance: difference of distance fields from this unit
          const dg = far.get(key(gl.x, gl.y)) ?? 99, dt = far.get(t) ?? 99;
          const md = Math.abs(gl.x - (t % 64)) + Math.abs(gl.y - ((t / 64) | 0));
          bd = Math.min(bd, Math.max(md, Math.abs(dg - dt)));
        }
        return bd;
      };
      const vul = u.items.find((i) => i.id === this.g.vulnerary);
      for (const [t, c] of r) {
        const occ = occupied.get(t);
        if (occ && occ !== u) continue;
        const tile = { x: t % 64, y: (t / 64) | 0 };
        const danger = (killed) => {
          let exp = 0, max = 0;
          for (const th of threat) {
            if (th.e === killed || !th.tiles.has(t)) continue;
            const s = this.strike(th.e, th.w, { x: th.e.x, y: th.e.y }, u, uw, tile, m) ||
              this.strike(th.e, th.w, tile.x + 1 < m.w ? { x: tile.x + 1, y: tile.y } : { x: tile.x - 1, y: tile.y }, u, uw, tile, m);
            if (!s) continue;
            const hits = s.doubles ? 2 : 1;
            exp += s.dmg * hits * s.p; max += s.dmg * hits;
          }
          return { exp, max };
        };
        const penalty = (dg, hp) => {
          let pen = dg.exp * 1.5;
          if (dg.max >= hp) pen += (lord ? 400 : 60) + (lord ? 300 : 80) * Math.min(1, dg.exp / Math.max(1, hp));
          return pen;
        };
        const progress = -3 * goalDist(t);
        // Option: seize
        if (lord && seizeKeys.has(t) && (!occ || occ === u)) {
          const s = { score: 100000, unit: u, dest: tile, kind: "seize", text: `${this.uname(u)} seizes the objective` };
          if (!best || s.score > best.score) best = s;
        }
        // Option: attack each enemy in range from here
        if (uw) for (const e of enemies) {
          const res = this.combat(u, uw, tile, e, this.weaponOf(e), { x: e.x, y: e.y }, m);
          if (!res) continue;
          const dg = danger(res.pKill > 0.6 ? e : null);
          const hpAfter = Math.max(1, u.hp - res.expTaken);
          const score = 120 * res.pKill + 2.5 * res.expDealt - (lord ? 600 : 200) * res.pDie - 1.2 * res.expTaken
            - penalty(dg, hpAfter) + progress * 0.3 + 5;
          if (!best || score > best.score) {
            best = { score, unit: u, dest: tile, kind: "attack", target: e,
              text: `${this.uname(u)} attacks ${this.uname(e)} (kill chance ${Math.round(res.pKill * 100)}%)` };
          }
        }
        // Option: heal with a Vulnerary when hurt
        if (vul && u.hp * 2 <= u.maxHP) {
          const dg = danger(null);
          const score = 40 + (u.maxHP - u.hp) * 3 - penalty(dg, Math.min(u.maxHP, u.hp + 10)) + progress * 0.2;
          if (!best || score > best.score) best = { score, unit: u, dest: tile, kind: "heal", slot: vul.slot, text: `${this.uname(u)} uses a Vulnerary` };
        }
        // Option: move (toward the goal, or to safety) and wait
        const dg = danger(null);
        const score = progress - penalty(dg, u.hp) + (t === key(u.x, u.y) ? 0.5 : 0);
        if (!best || score > best.score) {
          const toward = lord && seize.length ? "the objective" : "the enemy";
          best = { score, unit: u, dest: tile, kind: "move", text: dg.exp > 0 ? `${this.uname(u)} moves to a safer tile` : `${this.uname(u)} moves toward ${toward}` };
        }
      }
    }
    return best;
  }
  uname(u) {
    const names = { 1: "Eirika", 2: "Seth", 3: "Gilliam", 4: "Franz", 5: "Moulder", 6: "Vanessa", 7: "Ross",
      8: "Neimi", 9: "Colm", 0x0A: "Garcia", 0x0F: "Ephraim" };
    if (u.side === "blue" && names[u.charId]) return names[u.charId];
    return `the enemy at ${u.x},${u.y}`;
  }
}
