# Bearing Board — running game design document

**Status:** running spec. Present tense; describes the shipped game as it behaves today. Anything the design wants but the code does not yet do is confined to the final "Design intent not yet implemented" list.

## 1. Overview

**Pitch.** A travel-board dice race of wood, leather and brass: roll two dice, walk your markers around 24 triangular points, strike lone rival markers onto the rail, and bear everything off first.

| | |
|---|---|
| Genre | Turn-based race board game (original rules family, two rulesets) |
| Players | 1 human vs 1–3 deterministic AI rivals; 2-human pass-and-play on one device (practice only) |
| Session length | Practice duel 10–20 min; lessons 1–3 min; endgame stages 3–6 min; four-caravan circuits up to 25 min |
| Platforms | StarHermit engine 1.24.0 script game (host API 1.21): natively in the StarHermit client and in desktop and mobile browsers through the engine's web runtime; portrait and landscape |
| Rendering | `starhermit:scene` (three.js-like) perspective scene, all geometry procedural, the engine's post effects; the HUD and screens in `starhermit:ui` over it |
| Offline | Fully playable without any server; a guest makes no platform call. The daily's UTC day is the device's clock |

File map (everything that ships or is run):

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: name, description, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.*` (api 1, entry `native/main.ts`, version 1.24.0, minor 16, capabilities platform, storage, clipboard), `control.*` keys and `engine.gamepad.*` pads |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package` (`starhermit package --web .`); never edited |
| `native/main.ts` | Entry module: session controller (`Session`), goals, stars, achievements, app phases, commands, selection, the board cursor, pause / leave / restart, results, input (actions, pointer, touch) |
| `native/screens.ts` | HUD, rails, tray, lesson card, stakes and pause dialogs, toasts and the full-window screens in `starhermit:ui`; layouts by window size; frames the board in what the HUD leaves |
| `native/render.ts` | The board scene: procedural leather, wood and brass, markers, selection decals, cursor ring, tweens, sparks, motes, camera framing (view offset), picking by hit boxes |
| `native/quality.ts` | The four presets and their budgets by the runtime's quality tier and level |
| `native/audio.ts` | Sample cues on the runtime's mixer, the ambience bed and music pad rendered into clips |
| `native/platform.ts` | Save (progress) with conflict merge and foreign-save migration, the game's settings and legacy-settings migration, device storage, invite link, leaderboard posting |
| `native/i18n.ts`, `native/names.ts`, `native/style.ts` | Locale from the runtime's language; content names; UI styles from `assets/ui-style.json` |
| `js/rules.js` | Pure deterministic rules engine: config validation, move generation, `applyCommand`, scoring, hashing, replay |
| `js/ai.js` | Practice AI (casual / steady / sharp) and the hint generator, over the same legal-move API |
| `js/content.js` | Versioned content: 6 lessons, 40 journey stages, 8 challenges, daily generator, practice factory, 5 themes, 9 achievements, mastery tiers, validators |
| `js/progress.js`, `js/settings.js` | Progress document, conflict merge, browser-build cloud save reader; the game's options and the browser-build settings migration |
| `js/strings.js`, `js/i18n-*.js`, `js/account-strings.js` | Every player-facing string in the nine locales |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`) |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished game's match points and posts them to the `high-score` leaderboard |
| `server.js` | Local dev server (not packaged): static host plus same-origin `/api/v1` (time, authoritative sessions, replay) running the same `rules.js` |
| `assets/`, `sfx/`, `cover.jpg`, `coverart.png`, `icon.png` | Key art and results art, 21 Opus clips with manifests, store cover and icon |
| `tests/` | Node tests (rules, replay, content, server, progress, strings) and `native.mjs` (engine checks with `tests/native/*.play`) |
| `tools/` | `gen-play.mjs` (play scripts from the rules), `package-web.mjs`, `browser-play.mjs`, `ui-style.css` |

## 2. Vision and design pillars

1. **One engine, every seat.** `rules.js` is the only thing that changes game state, and it runs identically in the client, in the AI's search, in tests and in `server.js`. Rules in: `legalActions()` is what the HUD, the hints, the tutorial checker and the AI all call. Rules out: no UI-side rule shortcuts, no "AI-only" moves, no client-claimed winners.
2. **Race first, fight second.** Scoring, hints and the AI weights all favour pips and bear-offs over blot-hunting, and the Circuit ruleset has no cube so up to four caravans can simply run. Rules in: every mode ends by bearing off (or the move-limit tiebreak). Rules out: elimination modes, capture scoring, hidden information.
3. **Stakes without money.** The brass cube is a score multiplier that a duel opponent must answer before the next roll; declining is an honest concession at the old stakes. Rules in: cube in duels only, ownership passes to the acceptor, max value 64. Rules out: any currency framing, wagers, purchases affecting play.
4. **A table you can read with your ears shut and your eyes shut.** Every legal origin glows, every target is a green (or red, for a strike) disc, every rules event is announced to the screen reader and every board spot is reachable by the board cursor, and every sound has a text twin. Rules in: the board cursor is a real control surface (the play scripts play whole games through it). Rules out: hover-only cues, audio-only warnings, canvas-only controls.
5. **Replayable to the bit.** Seeds are visible in the HUD and results, dice come from `mulberry32` seeded per table, AI tie-breaks are seeded from public state, and a copied replay envelope reproduces the final hash. Rules in: scripted dice for lessons, immutable daily seeds. Rules out: cosmetic randomness touching rules (particles and audio use separate streams).

## 3. Player experience

**Target player.** Someone who knows or half-remembers a backgammon-style race and wants a calm, tactile ten-minute table against a rival that does not cheat, plus a longer authored ladder for mastery.

**First 60 seconds.** The title shows key art, a large `Play now`, and `Learn`. `Play now` opens a practice duel against the steady AI in one click . The HUD's objective line says "bear all your markers off first", the turn indicator says "You to roll", and only `Roll` is enabled. After the roll the legal origin markers carry a pulsing brass ring; tapping one lights its targets; a wrong tap gets a toast explaining why ("Your rail marker must re-enter first."). Players who pick `Learn` get six scripted-dice lessons whose tutorial card tells them the exact action to perform and advances only when the rules engine reports that action (`Session.watchTutorial`).

**Session shape.** Roll → pick → pick → (rival thinks 650 ms per command) → roll… A duel is about 40 turns per side. Undo (practice/journey/challenge) rewinds to the last roll; hints name the sharp AI's first move. The results screen gives the stakes × sweep breakdown, per-goal ticks, journey stars, achievements, and one-click `Retry` / `Next stage`.

**Emotional beat.** The strike: a 26-particle brass burst, a camera nudge, a wooden knock and a 40 ms haptic pulse when a lone marker is sent to the rail, followed by the quiet tension of having to re-enter it in the rival's home stretch.

## 4. Core loop and rules contract

All references are to `js/rules.js` unless stated.

### Board and entities
- 24 points (`POINTS`), each `{owner: -1|seat, count}`; per-seat `rail[]` and `off[]` counters. Marker totals are conserved (`markersOf`).
- Each seat has a personal track of distances 0..23 (`distanceOf`, `pointAtDistance`); distance 24 (`TRACK_LEN`) is off the board; distance ≥ 18 (`HOME_DIST`) is the home stretch.
- **Duel** (`RULESETS.duel`): 2 seats, 15 markers. Seat 0 travels point 24→1 (distance = 23 − point), seat 1 travels 1→24. Opening (`defaultLayout`): seat 0 has 2 on point 24, 5 on 13, 3 on 8, 5 on 6; seat 1 mirrored (2 on 1, 5 on 12, 3 on 17, 5 on 19). Cube allowed.
- **Circuit** (`RULESETS.circuit`): 2–4 seats, 8 markers each stacked on the seat's gate `startPoint = p·⌊24/players⌋` (gates 1/13; 1/9/17; 1/7/13/19 in 1-based UI numbering). Everyone travels the same direction. No cube.
- Point numbering in the UI is 1-based ("Point 24"); the two-row layout in `native/render.ts LAYOUT` puts points 1–12 on the near row (1 at the right) and 13–24 on the far row.

### Turn structure (`applyCommand`)
Phases: `roll → move (× dice) → roll …`, `cube` while an offer is pending, `over` when finished. Seat 0 always opens.
1. `roll`: two dice from the rules RNG (`rollDice`, `createRng(seed ^ 0x9e3779b9)`), or the next pair of `scriptedDice` if present. Doubles give `movesLeft = [d,d,d,d]`. If no move is legal the engine emits `noMoves`.
2. `move {from, to, die}`: must be one of `legalMoves()`. A landing on a lone rival marker is a hit: that marker goes to its owner's rail (`applyMoveRaw`). When `movesLeft` empties the turn ends (`endTurn`); when the mover has all markers off, the game ends first (`checkWin`).
3. `pass`: only legal when `canPass` (move phase, zero legal moves).
4. `double`: roll phase, cube enabled, cube value < 64, cube unowned or owned by the active seat (`canDouble`). Enters phase `cube`; the responder is the next seat.
5. `accept`: cube value doubles, responder becomes owner, play returns to the offerer's roll. `decline`: game ends, offerer wins at the pre-offer value.
6. `concede`: in a duel the other seat wins; in a circuit the conceding caravan is removed (`alive[p]=false`, its markers vanish) and play continues.
Every accepted command increments `tick`; every seat change increments `turnNum`. Invalid commands return `ok:false` with a reason string and increment the actor's `stats.invalid` (the invalid count is part of the authoritative state and a tiebreak input).

### Move legality (`candidateMoves`, `bestPlay`, `legalMoves`)
- A marker on the rail must re-enter before anything else moves; it enters at distance `die − 1` (the rival home stretch in a duel, the six points after your gate in a circuit). The rail never bears off.
- Destinations with two or more rival markers are blocked.
- Bearing off requires `allInHome`: no rail markers and every marker at distance ≥ 18. An exact die bears off; an over-sized die bears off only from the farthest occupied point.
- Full-dice rule: `bestPlay` searches every ordering and only returns first moves that reach the maximum number of dice playable. Higher-die rule: with a mixed roll, nothing played yet, and only one die playable, the higher die must be used if it can.
- Circuit tracks wrap modulo 24; blot exposure for the AI considers gaps of up to 12 pips because rivals approach from behind.

### Scoring (`buildResult`, `gammonFactor`)
`points = cubeValue × factor`. Factor 1 "Straight win". Factor 2 "Full sweep" when the worst-off surviving loser has borne off nothing. Factor 3 "Grand sweep" (duel only) when that loser also has a marker on the rail or inside the winner's home stretch. The breakdown rows are `Stakes value`, the sweep row if factor > 1, and `Match points`.

Worked example: seat 0 accepted a redouble (cube 4), then bore off its 15th marker while seat 1 had 0 off and 1 on the rail → factor 3, points 12, breakdown `Stakes value 4 · Grand sweep (×3) · Match points 12`. A declined offer at cube 2 (pending 4) ends with `cubeValue 2, factor 1, points 2, reason "decline"`.

### Terminal states and tie-breaks
- `bearoff` (all markers off), `decline`, `concede`, or `moveLimit` when `turnNum > options.moveLimit` after a turn ends (`finishByLimit`). Move-limit ranking: most borne off → fewer invalid actions → lower pip count → lower seat index.
- Session-level goals (`native/main.ts evaluateGoals`): `win`, `maxTurns`, `minHits`, `minPoints`, `maxHitsAgainst`, `maxTimeSec` (seat 0's own thinking time × timing-assist multiplier). Journey stars (`starsFor`): 1 for the win, +1 if every goal is met, +1 if within `par.turns` and `par.timeSec`.

### RNG, seeding and replay
- `hashSeed` is FNV-1a; `createRng` is mulberry32 with exposed state stored in `state.rng`, so a serialized state resumes the same dice stream.
- `hashState` hashes a canonical projection; `replay(cfg, commands)` rebuilds the state and returns per-command hashes. `Session.replayEnvelope()` in `native/main.ts` adds schema, build, content and rules versions, seed, initial hash, ISO start time, the command log and the terminal result; `Copy replay envelope` on the results screen puts it on the clipboard.
- Practice seeds default to `hashSeed('practice:<time>:<random>')` and can be typed in the setup form; daily seeds are `hashSeed('bearing-board:daily:v1:YYYY-MM-DD')`; lessons/journey/challenges carry fixed authored seeds.

### Undo and hints (`native/main.ts Session`)
- Undo is a snapshot stack taken at each human roll phase (`pushSnapshot`), available from the second checkpoint on, local transport only, and only when `def.mechanics.undo` is true (practice, lessons, journey, challenges; never daily). Undo restores state, truncates the command log and restores the thinking clock.
- Hint (`AI.suggestHint`) plans the sharp AI's whole turn and names the first move ("Move from point 13 to point 8 with the 5. It hits an exposed marker."), shown as a toast and announced.

### AI (`js/ai.js`)
- `casual`: uniformly random legal sequence; never doubles; drops only when far behind. `steady`: greedy one-ply on `evaluate` (off 60, pip −1.0, rail −28, blot −7, exposed −13, made 5, homeMade 4, anchor 6). `sharp`: exhaustive full-turn search with a 24 000-node budget and heavier weights, falling back to greedy if the search misses it. Cube: sharp doubles above a +26 edge, steady above +40; accept thresholds −75 / −55 / −20.
- All tie-break noise comes from `hashSeed('<seed>:<turn>:<seat>:plan')`, so the same position always yields the same decision.

## 5. Modes and progression

| Mode (title button) | Content | AI | Undo / hint | Ranked | Notes |
|---|---|---|---|---|---|
| Play now | `practiceDef('steady','duel')` with cube | steady | yes / yes | no | One click; `#play` deep link |
| Continue | Persisted device snapshot (storage key `snapshot`) | as saved | as saved | no | Replays the command log and verifies the hash; damaged saves restart fresh |
| Daily Crossing | `dailyForDate(todayUTC)` — 30% circuit (2–3 seats), else duel with 50% cube; difficulty and theme seeded | seeded | no / no | yes (flag) | Always a local table; the UTC day comes from the device's clock (the engine has no server-time call). Day counted as finished only on a win; countdown to next UTC day in the button |
| Journey | 40 stages in 5 chapters of 8 (Departure, Open Road, Home Stretch, Brass Stakes, Grand Circuit); every 8th is a Mastery stage with `maxTurns` | casual → steady → sharp | yes / yes | no | All stages open from the start; stars and best turns persist; `Next stage` on results |
| Learn | 6 lessons with scripted dice and step cards (roll & travel, blots, rail, doubles, bearing off, cube) | casual | yes / yes | no | `Finish lesson` marks it done; `Replay tutorials` in settings clears |
| Challenges | 8 constrained tables: Sprint (move limit 70), Blitz Clock (4 min thinking), Bare Rail, Sharp Table, High Brass (win at 4+), Clean Hands (≤2 hits taken), Caravan Master (4-seat circuit), Photo Finish (14-turn endgame) | steady/sharp | yes / yes | no | Cleared only when every goal is met |
| Practice setup | Ruleset, difficulty, seats (circuit 2–4), humans 1–2, theme, optional seed | chosen | yes / yes | no | Two humans = pass-and-play on one device; seats beyond the humans are AI |

Difficulty curve: chapter 1 is full duels vs casual with layouts that teach columns, splits and exposure; chapter 2 forces hits and rail work vs steady; chapter 3 is pure endgame counting with sharp sprints; chapter 4 adds the cube and `minPoints` goals; chapter 5 moves to the circuit ruleset with 2, 3 then 4 caravans. Journey stars feed mastery titles (`MASTERY_TIERS`: Packer 0, Wayfarer 10, Pathfinder 30, Guide 60, Master of Roads 90, Grand Bearer 120). Nine achievements (`ACHIEVEMENTS`) unlock idempotently in `applyOutcome`: first win, first sweep, 20 and 40 journey stages, 7 daily days, 50 lifetime hits, four-caravan circuit win, win at cube ≥ 4, 100 games.

## 6. Controls and interaction

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options (F1), and the game reads actions, never keys.

| Action | Keys | Gamepad | Does |
|---|---|---|---|
| `roll` | R | North (Y) | Roll (when legal) |
| `undo` | U | West (X) | Undo to the last roll |
| `hint` | H | Left shoulder | Hint (toast + announcement) |
| `pause` | Esc | Start | Pause card (Esc / East on it resumes) |
| `camera` | C | Right shoulder | Re-fit the camera |
| `prev` / `next` | ← ↑ / → ↓ | D-pad | Move the board cursor over the 26 spots (points 1–24, the rail, the off tray), announced as the browser build's board mirror buttons read ("Point 6: 5 of You, distance 18 for you") and shown as a brass ring |
| `confirm` | Enter | South (A) | Pick the cursor's spot (select origin, then target); on a pad with no cursor, roll |
| `cancel` | Backspace | East (B) | Clear the selection |

| Input | Action |
|---|---|
| Tap/click a glowing marker or point | Select origin; legal targets light (green disc, red for a strike) |
| Tap/click a lit target (point or off-tray) | Commit the move; if both dice reach it, the hitting move then the larger die is preferred (`commitMove`) |
| Tap/click another origin / empty board | Reselect / clear selection |
| Press-and-drag from origin to target | Commit on release (12 px threshold, <600 ms is a tap); with "Tap-to-select" off a failed drop clears the selection |
| Roll / Offer Stakes / Pass / Undo / Hint / Skip Anim | Tray buttons; disabled unless `legalActions` allows |
| Menus | Pointer, touch, Tab / arrows / Enter and the pad (D-pad, South, East) through `starhermit:ui`; Esc / East goes back |
| Pause card | Resume, Restart table, Settings, Help, Leave table (persists the snapshot) |

Input locking: board picks are ignored unless the table is up, unpaused and no stakes dialog is open; roll-phase and rival-turn taps get an explanatory toast. A pointer press right after a touch (one tap reported twice) is skipped. Commands carry unique ids (`makeCmdId`). The AI acts on a 650 ms game-clock timer (180 ms with reduced motion) and never while paused. Feedback per input: accepted command → `ack` click; selection → `select` peel and brass ring; illegal → `invalid` knock, toast, assertive announcement; cursor move → `tick`.

## 7. Screens and UI flow

App phases (`native/main.ts`): `title → journey | learn | challenges | setup → game (↔ pause card) → results → title`, with `settings` and `help` from the title or from the pause card (Done returns to the paused table). Overlays during play: the lesson card (lessons), the stakes dialog (Accept / Decline; Esc opens the pause card), the pause card, toasts. Backgrounding (the runtime's suspend) pauses a local game and flushes the save.

Layouts (`native/screens.ts`, by the window's logical size after the runtime's interface scale):
- **Desktop ≥ 1024:** HUD strip on top (objective ≤ 70ch, turn indicator, dice, Pause "II"), 240-wide Objective / Progress rail left, Table / players rail right, both from below the HUD to the tray, action tray centred at the bottom, lesson card above it.
- **Tablet 768–1023:** rails 200 wide.
- **Portrait < 768:** no rails; the objective takes its own line; dice 30 px; the tray spans the width with three buttons a row.
- **Short landscape (height ≤ 500):** only the Table rail (176), or the lesson card in its place; the tray beside it.
- Left-handed swaps the rails and docks the tray left. The runtime's interface size, text size and safe area apply to everything; menus scroll, their Back / Done / Menu / Retry rows stay pinned in view; the title shrinks its key art (and its heading) on short or narrow windows and puts the menu in two columns on wide, short ones.
- The board is framed in the rectangle the HUD leaves (a camera view offset, as the browser build's `setViewOffset`), refitted whenever it changes.

## 8. Art direction

**Hero.** The board itself: a leather field inside a walnut frame with brass corner caps, seen from a low authored perspective (fov 42°, tilt 54°, intro swoop of 0.9 s from above). Markers are squat cylinders (r 0.30, h 0.16) with a brass torus ring; stacks show at most five with the top one lifted when more are hidden.

**Palette.** UI tokens (`:root`): background `#0e1020`, panel `rgba(16,18,34,.92)` / `#151830`, ink `#f0ead8`, dim ink `#b8b09a`, accent brass `#d8b25c` on `#241a08`, danger `#d06a5a`, focus `#ffd97a`, lines `rgba(216,178,92,.35)`; dice faces `#f2ead6` on `#2a1c10`. Selection: origin ring `#ffd97a`, target disc `#7ac86a` / ring `#9ae08a`, strike target `#e06a4a`. Five table themes (`THEMES`), presentation only:

| Theme | board / alt | frame / rail | felt | accent | players (you, rival 1–3) | sky |
|---|---|---|---|---|---|---|
| Caravan Leather | `#caa06a` / `#7a4a2a` | `#5a3f28` / `#3a2a1c` | `#b98d55` | `#c9a25e` | `#f2e6cf` `#2e2018` `#8c3d2e` `#2e5a4a` | `#241a12` |
| Lagoon Voyage | `#9ac7c0` / `#2f6b66` | `#274b52` / `#1b3338` | `#7fb5ae` | `#e0b25c` | `#f4efe2` `#14343a` `#c96f4a` `#3a7ca5` | `#10222a` |
| Ember Night | `#d0a080` / `#8a3d2a` | `#4a2420` / `#2a1512` | `#bf8a60` | `#f0a03c` | `#f6e8d0` `#241210` `#d06a3a` `#6a8a5a` | `#1c100c` |
| Verdant Camp | `#b8c88f` / `#4a6a3a` | `#33482a` / `#20301c` | `#9ab57a` | `#d8b25c` | `#f0ead2` `#1e2a16` `#a8543a` `#4a6a8a` | `#141f10` |
| Midnight Brass | `#8f95b8` / `#3a3f66` | `#262a44` / `#171a2c` | `#6f76a0` | `#d8b25c` | `#e8e6f0` `#12142a` `#c05a5a` `#5aa08a` | `#0e1020` |

High-contrast mode swaps the UI tokens to pure black / white / `#ffdf4d`. The human is always the light disc; rival colours are reinforced by name and pip rows, never colour alone.

**Shape and material.** Boxes, cylinders, lathes and flat inlays only, all procedural. The board rests on a dark wooden tabletop that fades into the fog. The leather field is a shade darker than the theme felt; points are flat inlaid triangles in two alternating leather tones with a dark inlay border, merged into one mesh per tone, tapering toward the bar. PBR materials with ACES tone mapping at exposure 1.05 and sRGB output; one warm key light (`#fff1d6`) whose shadow frustum is fitted to the play area in light space, a cool hemisphere fill, a cool rim and (detailed tier) a warm lantern point light off the far-left corner, echoing the key art. Plain detail uses a seeded 128 px speckle (`makeLeatherTexture`) and cylinder markers; detailed uses seeded 512 px leather colour + bump maps with mottling, pores and creases (`makeLeatherMaps`), wood-grain maps on the lacquered walnut frame, bar and table (`makeWoodTexture`), saddle stitching around the field (one instanced mesh), brass hinges at the fold, and bevelled lathe markers with a groove under the brass ring in clearcoated `MeshPhysicalMaterial` (`makeMarkerGeometry`).

**Graphics.** Effects by preset: key-light shadows (1024 / 2048 / 4096, held by the runtime to the level's shadow cap; soft edges on High/Ultra), ambient occlusion (`renderer.ao`, GTAO settings of the browser chain; particles and selection decals left out with `noAO`), bloom limited to highlights and sparks (threshold 0.9, strength 0.3, the budget's resolution), the display-space colour grade (warm highlights, cooler shadows, gentle S-curve, vignette 0.28), FXAA / SMAA / MSAA, image-based reflections from `PMREMGenerator.fromScene(new RoomEnvironment(), 0.04)` (environment intensity 0.3, matched by eye to the browser build), the detailed board textures and geometry above, particle bursts (Low halves the counts; High/Ultra use additive sparks that bloom) and ambient motion (lantern flicker and drifting dust motes, stopped by reduced motion). Selection rings and target discs are not tone-mapped. The runtime's Options › Graphics owns Auto and the ten levels, render scale, the frame-rate limit and readout; the game picks its preset from `frame().quality` and scales sparks and motes within it by `frame().levelIndex` (≤ 2×), rebuilding board and markers when the budget changes (`native/quality.ts`). Low renders without post effects, lantern, environment or motes (MSAA on).

**Typography.** System UI stack (`system-ui, -apple-system, Segoe UI, Roboto`), title in accent brass with 0.06em tracking, rail titles uppercase 0.78em with 0.14em tracking, key names in the bindings line; the runtime's text size scales everything.

**Motion.** Markers slide from origin to slot in 320 ms ease-out-cubic; selection rings pulse at 4 rad/s; hits shake the camera at 0.06, game over at 0.1, decaying critically; particles are a 240-slot pool (hit 26, bear-off 12, game over 140). `Skip Anim` and any state change settle everything to the exact rules position. With reduced motion (the runtime's accessibility preference): no intro swoop, no shake, no particles, no slide tweens, AI delay 180 ms, results after 250 ms instead of 1100 ms.

**Visual assets the design calls for.** Title key art (leather board under lantern light), a victory illustration (full off-tray, brass cube), a "road goes on" illustration (board folding at dusk), and a store cover derived from the key art. All four ship (see §15).

**Presets and per-preset budgets** (`native/quality.ts`, the browser build's `TABLE` and `BUDGETS`; each was tuned to hold 60 FPS on the weakest GPU its Auto gave it). Low: no post effects, shadows, environment, lantern or motes, MSAA. Balanced: 1024 shadows, grade, FXAA, reflections, detailed board, no bloom. High: 2048 shadows, AO, bloom, grade, SMAA. Ultra: 4096 shadows, full AO, bloom, grade, MSAA.

| Preset | Markers | Materials | Leather / wood textures (detail on) | Leather relief (normal map) | Shadow filter | Spark pool | Dust motes | Bloom resolution |
|---|---|---|---|---|---|---|---|---|
| Low | 16-sided cylinder, cap ring merged in (1 draw) | Lambert board and markers, low-metal standard brass | — | — | — | 120 | 0 | ½ |
| Balanced | 24-segment lathed bevel, cap ring merged in | Standard (no clearcoat) | 256 px | off | PCF | 240 | 24 | ½ |
| High | 32-segment lathe + separate metallic ring | clearcoat Physical lacquer | 512 px | on | PCF soft | 240 | 40 | ¾ |
| Ultra | 48-segment lathe + separate metallic ring | clearcoat Physical lacquer | 1024 px (finer pores; mottling drawn at 512 and scaled) | on | PCF soft | 480 | 80 | full |

Textures (OffscreenCanvas `CanvasTexture`s, the relief as a `DataTexture` normal map) and meshes are generated procedurally and cached per theme and budget. Gameplay is identical on every preset.

## 9. Audio direction

The runtime's mixer and Options › Audio own volumes, mute and the voice limit. Event cues play on the `effects` bus (gain 0.8; win, lose, stars and unlock 0.7, the browser build's voice level), the interface clicks (ack, tick, select) on `interface`, the ambience bed and music pad on `music`. The ambience is a seeded brown-noise wind bed through a 420 Hz low-pass (a 3 s looped clip, gain 0.175); the music is a seeded slow pad (four chord shapes over a root chosen per table seed) ticking every 3.4 s. Both are rendered into clips (`createClip`) once the mixer runs, the chords one a frame, and stop on the title screen and while paused (the bed).

Every logical event routes through `audio.playEvent(name)`: it plays the mapped Opus clip, loaded once the mixer runs (natively at once, in a browser after the first press). Until then a cue is silent (the browser build's synthesized stand-ins are not ported: a live synthesis graph breaks clip loading in the web runtime). No cue is information-only: each has a HUD change, toast or announcement.

| Event id | File | Sound | Usage context |
|---|---|---|---|
| `ack` | `ui-ack.opus` | Soft wooden toggle click, brass latch | Every accepted command; every title-menu button |
| `roll` | `dice-roll.opus` | Dice rattle in a leather cup, tumble, settle | `roll` event, mixed dice |
| `doubles` | `dice-doubles.opus` | Same rattle landing matched, one brass bell tap | `roll` event with doubles |
| `move` | `checker-move.opus` | One checker sliding on varnished wood, soft tap | `move` event, point to point, no hit |
| `hit` | `checker-hit.opus` | Checker striking checker, struck piece slides onto leather | `move` event with `hit`; plus haptic and particles |
| `bearOff` | `bear-off.opus` | Checker lifted and dropped into a wooden tray | `bearOff` event |
| `enter` | `rail-enter.opus` | Checker taken from the rail and placed with a thud | `move` event from `rail` |
| `select` | `marker-select.opus` | Checker peeled off leather, faint fingernail tick | `selectOrigin()` |
| `undo` | `undo-slide.opus` | Two checkers swept backwards, double settle | `undoMove()` |
| `double` | `stakes-offer.opus` | Brass cube set down firmly | `double` event |
| `accept` | `stakes-accept.opus` | Brass cube picked up with a ring | `accept` event |
| `decline` | `stakes-decline.opus` | Brass cube pushed back, dull scrape | `decline` event |
| `invalid` | `invalid-move.opus` | Muted double knuckle knock | Rejected command, illegal pick |
| `noMoves` | `no-moves.opus` | Leather sigh and one low tap | `noMoves` event |
| `turn` | `turn-change.opus` | Quiet wooden tick | `turn` event |
| `tableOpen` | `table-open.opus` | Clasp click, leather creak, halves laid flat, cup set down | `launchSession()` |
| `win` | `game-win.opus` | Small brass bells and mallet roll | Results, you won (voice bus) |
| `lose` | `game-lose.opus` | Descending muted marimba, leather thud | Results, rival won (voice bus) |
| `stars` | `journey-stars.opus` | Three marimba taps and a bell shimmer | Results, journey stars ≥ 1 |
| `unlock` | `unlock-chime.opus` | Three ascending glass-and-brass chimes | `unlockAchievement()` |
| `tick` | `ui-tick.opus` | Very short dry wooden click | Arrow/D-pad focus move across mirror buttons |

This table is the source of `sfx/manifest.txt`; `sfx/manifest.json` carries the generator prompts and durations for the same 21 clips.

## 10. Localization

Nine locales ship for all player-facing text: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT** (`js/strings.js`: the `js/i18n-*.js` tables, the platform lines as `acc.*`, and the strings the engine client added).

- The locale follows the runtime's interface language (`preferences().language`: the player's choice in Options › Language, else the device's), mapped to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`); a change re-renders everything on the next frame while a table, its AI timers and the scene go on. The browser build's own Language selector, `?lang=` and the account preferred-language lookup are the runtime's now.
- Content keeps English data; names come by id (stages, chapters, lessons and every tutorial step, challenges, practice and daily names, themes, achievements, mastery titles, AI difficulties, rulesets). Help's trusted markup is shown as plain text with the key names kept.
- Text wraps by measured width (`ui.paragraph`, wrapping button rows), so German and Italian fit at 390 px.

## 11. Accessibility

- **Keyboard and pad:** every menu through `starhermit:ui` (Tab, arrows, Enter, Escape; D-pad, South, East); in play R rolls, the arrows move the board cursor and Enter picks, U / H / C / Esc for undo / hint / camera / pause, all rebindable in the runtime's Options.
- **Screen reader:** the UI's accessibility tree names every widget; `ui.announce` carries rolls, selections with their targets, bear-offs, passes, cube answers (polite) and hits, no-move turns, offers, invalid actions and game over (assertive); the board cursor announces each spot as the browser build's mirror buttons read.
- **Captions for audio:** every sound corresponds to a toast, HUD change or announcement.
- **Contrast, size, motion:** the runtime's high contrast, interface size, text size and reduced motion apply (reduced motion removes the swoop, shake, particles, tweens and motes and shortens AI and results delays); legal targets differ by shape (disc + ring) and a strike is also announced.
- **Game options (Settings):** table theme, left-handed layout, haptics, tap-to-select vs press-and-hold, timing assistance ×1 / ×1.5 / ×2, traveller name, replay tutorials, wipe progress, and a button to the runtime's Options.

## 12. StarHermit integration

- **Manifest:** `starhermit.txt` (see the file map); `launch=index.html` is the engine's loader.
- **Player:** `player()`; signing in and out is the runtime's (Account dialog / the client). Signed out, the title shows **Sign in with StarHermit** (`requestSignIn`); signed in, the profile name replaces the traveller name and **Invite a friend** copies the invite link (fetched ahead) to the clipboard. "Signed out of StarHermit" toasts when the session ends.
- **Save:** the progress document is the game's save (`saves`), on the device and in the account's cloud slot; a conflict merges both devices' documents with `mergeProgress` (better journey record per stage, lessons, challenges, union of daily days, earliest unlock of every achievement, larger stats), and an account copy that replaced the device's is adopted (toast "Progress from another device was merged."). The browser build's cloud save (the JS SDK's zipped `save.json` `{ data, check }` in `game:<slug>`) shows as foreign: it is checked, merged into the device's progress and replaces the slot once (`replaceForeign`).
- **Settings:** the game's options are `settings` (`game.<key>`, synced with the account). The browser build's per-player keys are read once (`settings.onLegacy`): theme, left-handed, haptics, tap-to-select, timing assistance and the traveller name migrate where unset; every legacy key (sound, graphics, frame-rate and language slots included) is then removed. The table in progress and the funnel stay on the device (`storage`).
- **Controls:** the platform keeps the declared actions' bindings with the account (renamed `cameraReset` → `camera`; a rebinding of it starts from the default).
- **Leaderboard:** signed in, every finished solo game except lessons posts seat 0's match points (0 for a loss) once through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': n } }`), and the results screen shows "Leaderboard rank: #N" (or posted / not posted). Hot-seat games and guests post nothing.
- **Reports and Options:** Report a problem, sound, graphics, language, controls and accessibility are the runtime's (F1 / the Settings button).
- **Not used:** StarHermit achievements (unlocks stay in the save), sessions/matchmaking/chat/replays, `server.js`'s routes, avatars, presence, voice.

## 13. Technical architecture

- **Rules boundary.** The client never mutates rules state; it calls `Rules.applyCommand`. `render.sync(state, events)` consumes the state plus the events for tweens and sparks.
- **Session controller** (`Session`): command log, undo snapshots (max 40), thinking clock on the game clock (seat 0 only), tutorial step matcher, AI scheduler (game-clock timers), persistence, replay envelope, outcome application.
- **Immediate-mode UI.** `onRender` rebuilds the HUD or the current screen each frame from state; actions that end the table being drawn (Finish lesson, Leave, Restart) run after the frame's UI.
- **Persistence keys:** save (progress, schema 1); settings `game.theme`, `leftHanded`, `haptics`, `toggleSelect`, `timingAssist`, `profileName`; storage `snapshot` (def + cfg + log + hash, cleared on finish) and `funnel` (anonymous local events, capped at 200).
- **Determinism:** rules streams as before; the scene's sparks use their own seeded stream; `tests/replay.test.mjs` proves identical hashes for identical seed + commands, and the play scripts are generated from the same rules and AI.
- **Picking** tests the browser build's hit volumes (24 point boxes, the rail, the off trays) as boxes along the pointer's ray.

## 14. Testing and acceptance criteria

`npm test`: `node --test tests/*.test.mjs` (44 tests: `rules`, `replay`, `content`, `server`, `progress` (merge, foreign save, settings migration), `strings` (every key and content name in all nine locales, every key the client asks for)) then `node tests/native.mjs`:
- the web index is up to date (`npm run package` ran after the last change), `tsc` (TypeScript 5.9, no skipLibCheck), `starhermit check .` with zero warnings;
- `tests/native/*.play` as signed-out render checks driving the real UI, generated by `node tools/gen-play.mjs` from the rules: `journey-race` (title → Journey by Tab → Home Stretch 2, pause/resume, played through the board cursor to results with Next stage), `challenge-photo` (Photo Finish to results, Retry, Leave table, Continue offered), `practice-duel` (Practice setup with selects and a typed seed, the stakes cube offered and declined, results), `lesson-first` (the first lesson's card through a roll and two moves, Finish lesson, Settings with a toggle, Help).

Browser checks (headless Chrome, one at a time): `node ../tools/engine-web-smoke.mjs .` (desktop + phone start without console errors) and `node tools/browser-play.mjs .` (desktop by keyboard to the pause card, a phone with taps on Roll and the board, a phone held sideways).

QA bar: a new player reaches a rolling table in one click; every feature in §5–§7 is reachable at desktop, phone and phone-landscape sizes with nothing cut off; no console errors or warnings; all 21 clips in `sfx/manifest.txt` exist and are bound to an event in `native/audio.ts`.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` | Title-screen hero image (1200×672, 57 KB) | FLUX.2 klein, seed 2712, 30 steps | shipped (title screen) |
| `assets/results-victory.webp` | Results illustration on a win (640×400, 20 KB) | FLUX.2 klein, seed 4101 | shipped (results screen) |
| `assets/results-road.webp` | Results illustration on a loss (640×400, 20 KB) | FLUX.2 klein, seed 4102 | shipped (results screen) |
| `coverart.png` | Store cover 1200×675, 256-colour PNG (345 KB) | Scaled from the key art | replaced the generic placeholder in this pass |
| `icon.png` | Icon | authored earlier | shipped |
| `sfx/*.opus` × 16 (ack, roll, move, hit, bearOff, enter, double, accept, decline, invalid, noMoves, turn, win, lose, unlock, tick) | Event cues | MOSS-SoundEffect v2.0 | shipped; `tick` newly bound to focus movement |
| `sfx/dice-doubles.opus`, `marker-select.opus`, `undo-slide.opus`, `table-open.opus`, `journey-stars.opus` | New cues: doubles, selection, undo, table open, stars | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired in `native/audio.ts` |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical table / generator input / generator output | hand-written / tool | shipped, in sync (21 entries each) |
| 3D models, character animation | — | TRELLIS / Kimodo | not called for: all geometry is procedural and there is no humanoid |

## 16. Known limitations

- `server.js` (development only, not packaged) serves every file under the game root.
- `concede` exists in the rules and the server whitelist but has no UI control; `Leave table` saves a snapshot instead.
- The thinking clock and Blitz goal only track seat 0; in pass-and-play the second human's time is not measured and hints/undo act for whichever human seat is active.
- The daily's UTC day comes from the device's clock (no server-time call on the engine).
- Until the mixer runs (in a browser, the first press) cues are silent; the browser build's synthesized stand-ins are not ported.
- Stacks above five markers show a lifted top disc but no count on the canvas; the exact count is only in the rail rows and the board cursor's announcement.
- The daily is marked complete only on a win, and "ranked" has no leaderboard behind it.
- The sharp AI's full-turn search on four-caravan doubles can take a noticeable fraction of a second on slow phones.
- `Copy replay envelope` writes to the clipboard during the press; where the system refuses, only the final hash is shown in a toast.
- Leather and wood are seeded procedural canvases (1024 px at most), not scanned materials.
- Finish lesson keeps the lesson's Continue snapshot, as the browser build did.
- The title screen shows the live board faintly behind its panel; there is no separate menu hero scene.

## Design intent not yet implemented

- Presence, activity start/end, a separate daily leaderboard, and platform-side achievement unlocks.
- A concede control in the pause dialog.
- A rendered brass stakes cube on the board (currently a HUD badge).
