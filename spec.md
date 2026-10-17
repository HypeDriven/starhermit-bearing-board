# Bearing Board — running game design document

**Status:** running spec. Present tense; describes the shipped game as it behaves today. Anything the design wants but the code does not yet do is confined to the final "Design intent not yet implemented" list.

## 1. Overview

**Pitch.** A travel-board dice race of wood, leather and brass: roll two dice, walk your markers around 24 triangular points, strike lone rival markers onto the rail, and bear everything off first.

| | |
|---|---|
| Genre | Turn-based race board game (original rules family, two rulesets) |
| Players | 1 human vs 1–3 deterministic AI rivals; 2-human pass-and-play on one device (practice only) |
| Session length | Practice duel 10–20 min; lessons 1–3 min; endgame stages 3–6 min; four-caravan circuits up to 25 min |
| Platforms | Desktop and mobile browsers with WebGL; portrait and landscape |
| Rendering | Three.js r160 (`vendor/three.module.min.js` + same-revision addons) perspective scene on one canvas, all geometry procedural, optional post-processing; semantic HTML UI layered over it |
| Offline | Fully playable without any server; standalone (no launch token) makes no `/api` or `/ws` request. Signed in, `GET /api/v1/time` syncs the clock |

File map (everything that ships or is run):

| Path | Responsibility |
|---|---|
| `index.html` | Shell: import map (`three`, `three/addons/`), canvas, HUD, rails, action tray, tutorial card, cube/pause dialogs, screen container, live regions, board mirror, frame-rate readout |
| `css/main.css` | Palette tokens, HUD/rail/tray layout, screens, breakpoints, accessibility variants |
| `js/rules.js` | Pure deterministic rules engine: config validation, move generation, `applyCommand`, scoring, hashing, replay |
| `js/ai.js` | Practice AI (casual / steady / sharp) and the hint generator, over the same legal-move API |
| `js/content.js` | Versioned content: 6 lessons, 40 journey stages, 8 challenges, daily generator, practice factory, 5 themes, 9 achievements, mastery tiers, validators |
| `js/audio.js` | WebAudio buses, procedural fallbacks, ambience, adaptive pad, sample loader for `sfx/*.opus` |
| `js/main.js` | Everything else: settings, progress, session controller, renderer, input, HUD, screens (including the Graphics settings section), platform adapter, boot |
| `js/gfx.js` | Pure graphics quality model: presets, categories, GPU detection, `resolve`, `presetTier`, `choosePreset`, `describe` |
| `js/gfx-strings.js` | Graphics-section and StarHermit account strings in the nine supported locales, `pickLocale` |
| `js/i18n.js`, `js/i18n-{en,es,de,fr,pt,it}.js` | Every other player-facing string (HUD, menus, results, settings, help, announcements, content names and texts) in the nine locales; language state and `data-i18n` application |
| `js/progress.js` | Progress document shape and the cloud-save conflict merge (`mergeProgress`) |
| `sh-language.js` | Shared StarHermit language preference (`window.StarHermitLanguage`), an unmodified copy of the canonical file |
| `js/post.js` | Loaded on demand: EffectComposer chain (GTAO, bloom, grade + vignette, SMAA/FXAA) and the PMREM room environment |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished game's match points and posts them to the `high-score` leaderboard (canonical copy in the games repo's `tools/score-script.js`) |
| `server.js` | Local dev server: static host plus same-origin `/api/v1` (time, authoritative sessions, replay) running the same `rules.js` |
| `starhermit.txt` | Platform manifest: `name`, `launch=index.html`, `owner`, `server=score-script.js`, `version`, `contentVersion`, `cover` |
| `assets/` | `key-art.webp` (title), `results-victory.webp`, `results-road.webp` |
| `sfx/` | 21 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (generator output) |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200x675) and icons |
| `tests/` | `rules`, `replay`, `content`, `server`, `gfx` node tests; `e2e.mjs` browser playthrough; `smoke.mjs` server boot check |
| `vendor/three.module.min.js` | Three.js r160 (MIT) |
| `vendor/three/addons/` | Three.js r160 (`three@0.160.1`) `examples/jsm` files used by `js/post.js`: postprocessing passes, their shaders, `SimplexNoise`, `RoomEnvironment` |
| `data/`, `tools/` | Present but empty; content lives in `js/content.js` |

## 2. Vision and design pillars

1. **One engine, every seat.** `rules.js` is the only thing that changes game state, and it runs identically in the browser, in the AI's search, in tests and in `server.js`. Rules in: `legalActions()` is what the HUD, the hints, the tutorial checker and the AI all call. Rules out: no UI-side rule shortcuts, no "AI-only" moves, no client-claimed winners.
2. **Race first, fight second.** Scoring, hints and the AI weights all favour pips and bear-offs over blot-hunting, and the Circuit ruleset has no cube so up to four caravans can simply run. Rules in: every mode ends by bearing off (or the move-limit tiebreak). Rules out: elimination modes, capture scoring, hidden information.
3. **Stakes without money.** The brass cube is a score multiplier that a duel opponent must answer before the next roll; declining is an honest concession at the old stakes. Rules in: cube in duels only, ownership passes to the acceptor, max value 64. Rules out: any currency framing, wagers, purchases affecting play.
4. **A table you can read with your ears shut and your eyes shut.** Every legal origin glows, every target is a green (or red, for a strike) disc, every rules event is announced to a live region and mirrored as DOM buttons, and every sound has a text twin. Rules in: the board mirror is a real control surface (the e2e test plays the whole game through it). Rules out: hover-only cues, audio-only warnings, canvas-only controls.
5. **Replayable to the bit.** Seeds are visible in the HUD and results, dice come from `mulberry32` seeded per table, AI tie-breaks are seeded from public state, and a copied replay envelope reproduces the final hash. Rules in: scripted dice for lessons, immutable daily seeds. Rules out: cosmetic randomness touching rules (particles and audio use separate streams).

## 3. Player experience

**Target player.** Someone who knows or half-remembers a backgammon-style race and wants a calm, tactile ten-minute table against a rival that does not cheat, plus a longer authored ladder for mastery.

**First 60 seconds.** The title shows key art, a large `Play now`, and `Learn`. `Play now` opens a practice duel against the steady AI in one click (two from a deep link `#play`). The HUD's objective line says "bear all your markers off first", the turn indicator says "You to roll", and only `Roll` is enabled. After the roll the legal origin markers carry a pulsing brass ring; tapping one lights its targets; a wrong tap gets a toast explaining why ("Your rail marker must re-enter first."). Players who pick `Learn` get six scripted-dice lessons whose tutorial card tells them the exact action to perform and advances only when the rules engine reports that action (`Session.watchTutorial`).

**Session shape.** Roll → pick → pick → (rival thinks 650 ms per command) → roll… A duel is about 40 turns per side. Undo (practice/journey/challenge) rewinds to the last roll; hints name the sharp AI's first move. The results screen gives the stakes × sweep breakdown, per-goal ticks, journey stars, achievements, and one-click `Retry` / `Next stage`.

**Emotional beat.** The strike: a 26-particle brass burst, a camera nudge, a wooden knock and a 40 ms haptic pulse when a lone marker is sent to the rail, followed by the quiet tension of having to re-enter it in the rival's home stretch.

## 4. Core loop and rules contract

All references are to `js/rules.js` unless stated.

### Board and entities
- 24 points (`POINTS`), each `{owner: -1|seat, count}`; per-seat `rail[]` and `off[]` counters. Marker totals are conserved (`markersOf`).
- Each seat has a personal track of distances 0..23 (`distanceOf`, `pointAtDistance`); distance 24 (`TRACK_LEN`) is off the board; distance ≥ 18 (`HOME_DIST`) is the home stretch.
- **Duel** (`RULESETS.duel`): 2 seats, 15 markers. Seat 0 travels point 24→1 (distance = 23 − point), seat 1 travels 1→24. Opening (`defaultLayout`): seat 0 has 2 on point 24, 5 on 13, 3 on 8, 5 on 6; seat 1 mirrored (2 on 1, 5 on 12, 3 on 17, 5 on 19). Cube allowed.
- **Circuit** (`RULESETS.circuit`): 2–4 seats, 8 markers each stacked on the seat's gate `startPoint = p·⌊24/players⌋` (gates 1/13; 1/9/17; 1/7/13/19 in 1-based UI numbering). Everyone travels the same direction. No cube.
- Point numbering in the UI is 1-based ("Point 24"); the two-row layout in `main.js LAYOUT` puts points 1–12 on the near row (1 at the right) and 13–24 on the far row.

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
- Session-level goals (`main.js evaluateGoals`): `win`, `maxTurns`, `minHits`, `minPoints`, `maxHitsAgainst`, `maxTimeSec` (seat 0's own thinking time × timing-assist multiplier). Journey stars (`starsFor`): 1 for the win, +1 if every goal is met, +1 if within `par.turns` and `par.timeSec`.

### RNG, seeding and replay
- `hashSeed` is FNV-1a; `createRng` is mulberry32 with exposed state stored in `state.rng`, so a serialized state resumes the same dice stream.
- `hashState` hashes a canonical projection; `replay(cfg, commands)` rebuilds the state and returns per-command hashes. `Session.replayEnvelope()` in `main.js` adds schema, build, content and rules versions, seed, initial hash, ISO start time, the command log and the terminal result; `Copy replay envelope` on the results screen puts it on the clipboard.
- Practice seeds default to `hashSeed('practice:<time>:<random>')` and can be typed in the setup form; daily seeds are `hashSeed('bearing-board:daily:v1:YYYY-MM-DD')`; lessons/journey/challenges carry fixed authored seeds.

### Undo and hints (`main.js Session`)
- Undo is a snapshot stack taken at each human roll phase (`pushSnapshot`), available from the second checkpoint on, local transport only, and only when `def.mechanics.undo` is true (practice, lessons, journey, challenges; never daily). Undo restores state, truncates the command log and restores the thinking clock.
- Hint (`AI.suggestHint`) plans the sharp AI's whole turn and names the first move ("Move from point 13 to point 8 with the 5. It hits an exposed marker."), shown as a toast and announced.

### AI (`js/ai.js`)
- `casual`: uniformly random legal sequence; never doubles; drops only when far behind. `steady`: greedy one-ply on `evaluate` (off 60, pip −1.0, rail −28, blot −7, exposed −13, made 5, homeMade 4, anchor 6). `sharp`: exhaustive full-turn search with a 24 000-node budget and heavier weights, falling back to greedy if the search misses it. Cube: sharp doubles above a +26 edge, steady above +40; accept thresholds −75 / −55 / −20.
- All tie-break noise comes from `hashSeed('<seed>:<turn>:<seat>:plan')`, so the same position always yields the same decision.

## 5. Modes and progression

| Mode (title button) | Content | AI | Undo / hint | Ranked | Notes |
|---|---|---|---|---|---|
| Play now | `practiceDef('steady','duel')` with cube | steady | yes / yes | no | One click; `#play` deep link |
| Continue | Persisted local snapshot (`bb.snapshot.v1`) | as saved | as saved | no | Replays the command log and verifies the hash; damaged saves restart fresh |
| Daily Crossing | `dailyForDate(todayUTC)` — 30% circuit (2–3 seats), else duel with 50% cube; difficulty and theme seeded | seeded | no / no | yes (flag) | Always a local table; the UTC day comes from server time when signed in, else the local clock. Day counted as finished only on a win; countdown to next UTC day in the button |
| Journey | 40 stages in 5 chapters of 8 (Departure, Open Road, Home Stretch, Brass Stakes, Grand Circuit); every 8th is a Mastery stage with `maxTurns` | casual → steady → sharp | yes / yes | no | All stages open from the start; stars and best turns persist; `Next stage` on results |
| Learn | 6 lessons with scripted dice and step cards (roll & travel, blots, rail, doubles, bearing off, cube) | casual | yes / yes | no | `Finish lesson` marks it done; `Replay tutorials` in settings clears |
| Challenges | 8 constrained tables: Sprint (move limit 70), Blitz Clock (4 min thinking), Bare Rail, Sharp Table, High Brass (win at 4+), Clean Hands (≤2 hits taken), Caravan Master (4-seat circuit), Photo Finish (14-turn endgame) | steady/sharp | yes / yes | no | Cleared only when every goal is met |
| Practice setup | Ruleset, difficulty, seats (circuit 2–4), humans 1–2, theme, optional seed | chosen | yes / yes | no | Two humans = pass-and-play on one device; seats beyond the humans are AI |

Difficulty curve: chapter 1 is full duels vs casual with layouts that teach columns, splits and exposure; chapter 2 forces hits and rail work vs steady; chapter 3 is pure endgame counting with sharp sprints; chapter 4 adds the cube and `minPoints` goals; chapter 5 moves to the circuit ruleset with 2, 3 then 4 caravans. Journey stars feed mastery titles (`MASTERY_TIERS`: Packer 0, Wayfarer 10, Pathfinder 30, Guide 60, Master of Roads 90, Grand Bearer 120). Nine achievements (`ACHIEVEMENTS`) unlock idempotently in `applyOutcome`: first win, first sweep, 20 and 40 journey stages, 7 daily days, 50 lifetime hits, four-caravan circuit win, win at cube ≥ 4, 100 games.

## 6. Controls and interaction

| Input | Action |
|---|---|
| Tap/click a glowing marker or point | Select origin; legal targets light (green disc, red for a strike) |
| Tap/click a lit target (point or off-tray) | Commit the move; if both dice reach it, the hitting move then the larger die is preferred (`commitMove`) |
| Tap/click another origin | Reselect |
| Tap empty board / Esc | Clear selection |
| Press-and-drag from origin to target | Commit on release (12 px threshold, <600 ms is a tap); with "Tap-to-select" off a failed drop clears the selection |
| Roll / Offer Stakes / Pass / Undo / Hint / Skip Anim | Tray buttons; disabled unless `legalActions` allows |
| `R` `U` `H` `C` `Esc` | Roll, undo, hint, camera reset, pause (physical keys via `event.code`; StarHermit control overrides apply when signed in; never with Ctrl/Meta/Alt) |
| `←` `→` `↑` `↓`, `Enter` | Roving focus across the 26 board-mirror buttons (24 points, rail, off tray); Enter activates |
| Gamepad | Start pauses, A confirms focused button (or rolls), B clears selection, D-pad left/right roves the mirror |
| Pause dialog | Resume, Restart table (local only), Settings, Help, Leave table (persists the snapshot) |

Input locking: canvas picks are ignored unless `appPhase === 'game'` and it is a human turn in the move phase; roll-phase and rival-turn taps get an explanatory toast rather than silence. Commands carry unique ids (`makeCmdId`). The AI acts on a 650 ms timer (180 ms with reduced motion) and never while paused. Feedback per input: accepted command → `ack` click plus HUD refresh; selection → `select` peel and brass ring; illegal → `invalid` knock, toast, assertive announcement; focus move → `tick`.

## 7. Screens and UI flow

`appPhase` in `main.js`: `title → mode-select (Journey | Learn | Challenges | Practice setup) → game ↔ paused → results → title`, with `settings` and `help` reachable from the title or from pause (returning to the paused game). Overlays during `game`: tutorial card (lessons), cube dialog (focus goes to Accept when it opens), pause dialog (focus to Resume), toasts. Backgrounding the tab auto-pauses a local game and stops the render loop; returning resumes rendering and re-fits the camera.

Layouts (`css/main.css`):
- **Desktop ≥1024 px:** HUD strip on top (objective ≤70ch, turn indicator, dice tray, pause), 15 rem Objective/Progress rail left, 15 rem Table/players rail right, action tray centred at the bottom. Board camera auto-fits `FRAMING.halfW 7.1 × halfH 3.55` with a 54° tilt.
- **Tablet 768–1023 px:** rails narrow to 12.5 rem.
- **Portrait mobile ≤767 px:** rails hidden; objective wraps to a full-width line; dice shrink to 30 px; the tray spans the width with 30%-wide buttons; tutorial card sits above the tray.
- **Landscape mobile (height ≤500 px):** only the right rail (11 rem) remains; the tray docks to its left.
- **Large screens (above 1600×1000):** `ui-scale.js` sets `--ui-scale` (1 up to a 1600×1000 viewport, then the smaller of width/1600 and height/1000, capped at 2.5) and the whole `#bb-ui` layer — HUD, rails, tray, tutorial card, dialogs, toasts and screens — is CSS-`zoom`ed by it (vw/vh lengths inside are divided by it); the full-window canvas is not zoomed, and the board camera re-fits to the safe rectangle left by the larger chrome.
- Safe areas: every fixed element offsets by `env(safe-area-inset-*)`; the viewport meta uses `viewport-fit=cover`.
- Must never be cut off: turn indicator, dice tray, Roll/Pass buttons, cube Accept/Decline, tutorial text, results `Menu`/`Retry`. Screens scroll vertically; the key-art and result illustrations shrink on short viewports.

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

**Graphics.** Optional effects: key-light shadows (1024² / 2048² / 4096²; PCF soft filtering on High/Ultra, plain PCF below), GTAO ambient occlusion for contact darkening under markers and along the frame (particles and selection decals are hidden from its depth pass), bloom limited to highlights and sparks (threshold 0.9), a colour grade with warm highlights, cooler shadows, gentle S-curve and vignette, FXAA/SMAA/MSAA anti-aliasing, image-based reflections from a PMREM `RoomEnvironment` on brass, lacquer and clearcoat, the detailed board textures and geometry above, particle bursts (Low halves the counts; High uses additive sparks that bloom) and ambient motion (lantern flicker and the budget's drifting dust motes, stopped by reduced motion). Selection rings and target discs are not tone-mapped, so they keep their exact colours. The Settings screen's **Graphics** section offers a quality preset (Auto, chosen from the StarHermit hardware level below; Low; Balanced; High; Ultra), a render scale (50–200%, multiplying the preset's), one override per category (shadows, ambient occlusion, bloom, colour grade, anti-aliasing, reflections, board detail, particles, ambient motion; "From preset (…)" by default; choosing a preset clears overrides), adaptive resolution (on by default; averages 90 frames, steps down 0.1 to a floor of 0.6 when frames average over 26 ms and back up 0.05 when under 14 ms) and a frame-rate readout, plus a summary line "GPU · Level N · cost summary · W×H px" (localized). Pixel ratio = min(device ratio, preset cap 1 / 1.5 / 2 / 2) × preset scale (Ultra 1.25) × render scale × adaptive scale, capped at 3. Changes apply immediately and persist in `bb.settings.v1` under `graphics`; the resolved preset and tiers are mirrored as `data-gfx-*` attributes on `body` and `#bb-canvas`. The post chain and environment are loaded with a dynamic `import('./post.js')` only when needed; if they cannot be built the board renders directly and the section shows a note. Low renders without a composer, lantern, environment or motes.

**Typography.** System UI stack (`system-ui, -apple-system, Segoe UI, Roboto`), title in accent brass with 0.06em tracking, rail titles uppercase 0.78em with 0.14em tracking, monospace `kbd` chips for bindings; `Larger text` scales the root by 1.2.

**Motion.** Markers slide from origin to slot in 320 ms ease-out-cubic; selection rings pulse at 4 rad/s; hits shake the camera at 0.06, game over at 0.1, decaying critically; particles are a 240-slot pool (hit 26, bear-off 12, game over 140). `Skip Anim` and any state change settle everything to the exact rules position. With reduced motion (OS preference honoured until overridden): no intro swoop, no shake, no particles, no slide tweens, AI delay 180 ms, results after 250 ms instead of 1100 ms.

**Visual assets the design calls for.** Title key art (leather board under lantern light), a victory illustration (full off-tray, brass cube), a "road goes on" illustration (board folding at dusk), and a store cover derived from the key art. All four ship (see §15).

**Hardware level and Auto.** `gpu-level.js` (shared StarHermit detector, `window.StarHermitGpu`, loaded before `js/main.js`) rates the GPU 0–20 (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; laptop parts two levels lower; phones, tablets and ≤ 4 GB machines capped at 9; software renderers 0). Auto picks **Low 0, Balanced 4, High 10, Ultra 17**; adaptive resolution still steps down when frames are slow. On phones and tablets the shared frame-rate option paces Auto at half the display refresh rate and starts with 16 simultaneous sounds.

**Presets and per-preset budgets** (`TABLE` and `BUDGETS` in `js/gfx.js`; each tuned to hold 60 FPS on the weakest GPU Auto gives it — Low: level 0, Balanced: level 4 Iris Xe, High: level 10 GTX 1070, Ultra: level 17 RTX 4080). Low: no post chain, shadows, environment, lantern or motes, canvas MSAA. Balanced: 1024² shadows, colour grade, FXAA, reflections, detailed board, no bloom (the 13-pass bloom chain was its largest cost). High: 2048² shadows, GTAO, bloom, grade, SMAA. Ultra: 4096² shadows, full GTAO, bloom, grade, MSAA, 1.25× scale.

| Preset | Markers | Materials | Leather / wood textures (detail on) | Leather bump | Shadow filter | Spark pool | Dust motes | Bloom resolution |
|---|---|---|---|---|---|---|---|---|
| Low | 16-sided cylinder, cap ring merged in (1 draw) | Lambert board and markers, Phong brass | — | — | — | 120 | 0 | ½ |
| Balanced | 24-segment lathed bevel, cap ring merged in | Standard (no clearcoat) | 256 px | off | PCF | 240 | 24 | ½ |
| High | 32-segment lathe + separate metallic ring | clearcoat Physical lacquer | 512 px | on | PCF soft | 240 | 40 | ¾ |
| Ultra | 48-segment lathe + separate metallic ring | clearcoat Physical lacquer | 1024 px (finer pores) | on | PCF soft | 480 | 80 | full |

Spark bursts and dust motes scale within the preset by the hardware level (`StarHermitGpu.scaleBudget`, ≤ 2×; fewer below the floor). Textures and meshes are generated procedurally at load; a preset change that alters the budget rebuilds the board and markers. Gameplay is identical on every preset.

**60 FPS benchmark** (`node tools/gfx-bench.mjs bearing-board [--mobile --presets low,balanced]`, dev-only, real GPUs; hook `tests/gfx-bench.mjs` picks the preset in Settings → Graphics, starts a practice duel with Play now and keeps playing via Roll and the board's keyboard mirror). Measured 2026-10-17 under heavy machine load:

- Desktop 1920×1080: FAIL low (GPU p90 14.09 ms on level 2 → ≈ 21.32 ms at level 0, CPU p90 0.70 ms; 11.11 ms → ≈ 16.81 ms when it is not the first preset run); PASS balanced (19.62 → ≈ 12.97 ms at level 4, CPU 0.80 ms); PASS high (55.55 → ≈ 10.60 ms at level 10, CPU 1.20 ms); PASS ultra (136.62 → ≈ 6.12 ms at level 17, CPU 1.10 ms).
- Mobile 390×844 @3×: FAIL low (16.89 → ≈ 25.56 ms, CPU 0.60 ms); PASS balanced (16.80 → ≈ 11.11 ms, CPU 0.80 ms).
- Low is at the benchmark's floor: an empty WebGL page measured 11.0–11.5 ms (desktop) and 13–15 ms (mobile) on the iGPU around these runs, against a 9.25 ms allowance at level 2.

## 9. Audio direction

Four independent gain buses (`music` 0.45, `effects` 0.8, `ambience` 0.35, `voice` 0.7 defaults) created lazily on the first user gesture; a master enable mutes all. Backgrounding suspends the context; returning resumes it. Ambience is a seeded brown-noise wind bed through a 420 Hz low-pass; music is a seeded slow pad (four chord shapes over a root chosen per table seed) ticking every 3.4 s. Both stop on the title screen.

Every logical event routes through `Audio.playEvent(name, seed)`: it plays the mapped Opus clip if decoded, otherwise the procedural synth for that event, so the game is never silent while a clip loads. Seeded pitch variance (±8%) keeps replays consistent. No cue is information-only: each has a HUD change, toast or live-region text.

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

Nine locales ship for all player-facing text: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Strings**: `js/i18n-*.js` hold the static markup (`data-i18n`, `data-i18n-aria` on `index.html`: HUD, rails, action tray, cube and pause dialogs, board-mirror label, WebGL fallback) and everything `js/main.js` builds: title, Journey/Learn/Challenges lists, Practice setup, results (breakdown rows by key, goals rendered from key + values, reasons, achievements, mastery), Settings, Help (trusted markup per section), HUD objective and turn indicator, dice and player rows, board mirror, cube offer, hints (built from `AI.suggestHint`'s structured move), refusal reasons, screen-reader announcements and toasts. Content keeps English data; names come by id: 40 stage names and blurbs, 5 chapter titles, 6 lessons with every tutorial step, 8 challenges, practice and daily names/blurbs, 5 themes, 9 achievements, 6 mastery titles, 3 AI difficulties, 2 rulesets. The default guest name is shown in the current language. The Graphics section and the account/leaderboard lines come from `js/gfx-strings.js` for the same locale. Event announcements and the turn indicator use "{who}: …" phrasing in German, French and Italian so "you" never needs a third-person verb; en-GB uses "Traveller"/"colour"; es-ES says "Intro"; fr-CA says "pointage". `<html lang>` is the resolved tag.
- **Language setting**: Settings → **Language → Game language** (rendered by `game-options.js` inside the Graphics section; Settings opens from the title and from the pause dialog) offers **Automatic — <resolved language>** plus the nine locales by native name, with a status line (Saved to account / Saved on this device / Account sync unavailable). A change applies immediately: markup is re-applied; Settings and Practice setup relabel in place (choices and focus kept); other menu screens and the results screen re-render (without replaying sounds or re-posting the score); a table in progress re-renders its HUD, board mirror, tutorial card and cube dialog while its state, AI timers and the 3D scene continue.
- **Resolution** (`sh-language.js`): explicit game choice → for Automatic, the StarHermit account's `preferredLanguage` (`GET /api/v1/me/language`, signed in only) → `navigator.languages` → `en-US`. Tags map to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`). The choice (`auto` or a locale) is stored per player in `localStorage['bearing-board.language.<user|guest>']` and, when signed in, in the per-player settings key `ui.language` as `{ choice }`; a failed settings read never overwrites it and the game never writes the platform preference. Standalone play makes no language request. `?lang=<tag>` forces a locale for the page load (QA links) and hides the selector.
- Layout tolerates expansion: buttons wrap in the tray, tiles are `minmax(13.5rem,1fr)`, objective and rail text cap at 70ch and wrap, and `[dir="rtl"]` flips the tray; German and Italian were checked at 390 px.

## 11. Accessibility

- **Keyboard-only path:** title menu and every screen are plain buttons/selects; in play, `R` rolls, arrows rove the 26 mirror buttons and `Enter` selects/commits, `U`/`H`/`Esc` for undo/hint/pause; dialogs move focus in (Accept, Resume) and back out (pause button). Visible 3 px `#ffd97a` focus ring on every control.
- **Screen reader:** `#bb-board-mirror` lists every point as "Point N: 3 of You, distance 12 for you", the rail and the off tray, refreshed after every state change; `#bb-live` (polite) carries rolls, selections with target lists, bear-offs, passes, cube answers; `#bb-live-assertive` carries hits, no-move turns, offers, invalid actions and game over.
- **Captions for audio:** every sound corresponds to a toast, HUD change or announcement listed above.
- **Contrast and colour:** ink on panel ≈ 12:1; brass accent on `#241a08` for primary buttons; high-contrast toggle to black/white/yellow; legal targets differ by shape (disc + ring) and the strike colour is also announced in text.
- **Reduced motion:** OS preference honoured by default, overridable; removes camera swoops, shake, particles and tweens while keeping event timing.
- **Sizes and options:** all buttons ≥ 44×44 CSS px with 0.5 rem gaps; larger text (×1.2); left-handed layout swaps rails and docks the tray left; haptics toggle; tap-to-select vs press-and-hold; timing assistance ×1 / ×1.5 / ×2 for timed goals; tutorial replay.

## 12. StarHermit integration

Conventions from https://wiki.starhermit.com/ used today:
- **Manifest:** `starhermit.txt` with `name=Bearing Board`, `launch=index.html`, `owner=<uuid>`, `server=score-script.js`, `version=1.0.0`, `contentVersion=1`, `cover=coverart.png`.
- **Server script:** `score-script.js` is the platform script (leaderboard posting, below). `server.js` (local dev server) serves the distribution and a same-origin `/api/v1` implemented with the shared `rules.js`: `GET time` (the only route the client calls, and only when signed in: round-trip-adjusted offset in `platform.init`, used for the daily's UTC day and countdown), and — exercised only by the server tests, not called by the client — `POST sessions` (validated config → authoritative table), `GET sessions/:id` (reconnect snapshot; the client shows "While you were away: N table events"), `POST sessions/:id/commands` (seat 0 only, short unique `id`, type whitelist, 8 KB body cap, 60 requests / 10 s per address, duplicate ids answered idempotently, AI seats played out server-side), `GET sessions/:id/replay` (envelope with hashes). Sessions are in-memory, capped at 500 by last touch.
- **SDK:** `starhermit-sdk.js` (verbatim copy of the canonical client) loads as a classic script before `js/main.js`, which calls `StarHermit.init()` first thing; `js/account.js` (`createAccount`) wraps the account calls and `platform` in `js/main.js` wires them to the UI. Without a token no StarHermit request is made.
- **Launch token and renewal:** the SDK reads `#game_token=<jwt>[&session_id=]` or a sign-in return `#access_token=…`, strips it, takes the slug from `game_scope` (never hard-coded) and renews via `POST /api/v1/games/{slug}/launch-token`. The token also rides as `Authorization: Bearer` on `GET api/v1/time`. If renewal is refused the player sees "Signed out of StarHermit — progress stays on this device." and keeps playing locally. No tokens are persisted.
- **Sign-in:** on `*.starhermit.com` without a token the title menu shows **Sign in with StarHermit** (`StarHermit.signIn()`); hidden when signed in and locally.
- **Identity:** the profile nickname from `GET /api/v1/users/{sub}/profile` (never `/api/v1/me`; `Player <id>` fallback) replaces the local guest name on the title line.
- **Cloud save:** the progress document (`{ data, check }`, the same checksummed shape as `bb.progress.v1`) mirrors to `/api/v1/me/cloud-saves/game:{slug}`. On start a valid remote copy wins over the local one; otherwise the local copy seeds the slot. Every `saveProgress` queues a debounced upload, flushed on `pagehide`/hidden. Settings, snapshots and the daily session id stay local.
- **Settings KV:** every `saveSettings` sends the changed keys (audio, volumes, graphics, theme, reduced motion, contrast, text size, handedness, haptics, tap-to-select, timing assistance, guest name) with `PATCH /api/v1/games/{slug}/settings`; on start the platform's values override local ones.
- **Invite:** when signed in the title menu shows **Invite a friend**, which copies `StarHermit.inviteLink()` and confirms with a toast (the link is shown when the clipboard is blocked).
- **Controls:** `starhermit.txt` declares `control.roll`, `undo`, `hint`, `pause`, `cameraReset`, `prev`, `next`; keydown routes by `event.code` through `StarHermit.loadBindings` (defaults standalone), and Settings → Keyboard bindings lists the effective keys.
- **Leaderboard:** when signed in, every finished solo game except lessons posts seat 0's match points (0 for a loss) through `StarHermit.submitScores` (a practice session whose `score-script.js` posts it to the `high-score` board "Match points", integer, higher is better, 0–192), once per game, and the results screen shows "Leaderboard rank: #N" (or posted / not posted). Hot-seat games with more than one human and standalone play post nothing.
- **Strings:** sign-in, invite, toast, sign-out and leaderboard texts exist in all nine locales (`ACCOUNT_STRINGS` in `js/gfx-strings.js`) and follow the game language.
- **Language preference:** Automatic follows the account's preferred language; an explicit choice syncs as `ui.language` (§10).
- **Save conflicts:** cloud writes after a load are conditional; when another device saved first the SDK refuses the write and emits `saveconflict`. `account.onSaveConflict` re-reads the cloud copy (lifting the write block) and `mergeProgress` (`js/progress.js`) combines it with local progress: the better Journey record per stage (more stars, fewer turns, goals met), finished lessons and challenges (best turns), the union of daily days with the latest day, every achievement with its earliest unlock, and the larger of each stat. The merge is saved locally and written back; settings and any table in progress stay local.
- **Reports:** Settings → **Report a problem** (signed in only, from `game-options.js`) files a bug report through `StarHermit.reportBug` with a small non-personal `context.json` (viewport, language, FPS cap, audio limit); uncaught errors are filed as crash reports through `StarHermit.captureCrashes` (SDK-capped). Standalone play shows no report section and sends nothing.
- On the platform the game's own session routes only exist if the declared backend runs in front of them; otherwise the daily start falls back to a local table with a toast, with no console errors.
- **Not used:** StarHermit achievements (unlocks stay local), platform sessions/matchmaking/invites/chat/replays, the `server.js` session routes, avatars (no player chip), presence, voice, WebSocket events. The daily's `ranked: true` flag is informational; the daily posts to the same `high-score` board as any other solo game.

## 13. Technical architecture

- **Rules boundary.** `main.js` never mutates rules state; it calls `Rules.applyCommand`. Rendering (`createRenderer.sync`) consumes the immutable state plus the event list for tweens.
- **Session controller** (`Session`): command log, undo snapshots (max 40), thinking clock (seat 0 only), tutorial step matcher, AI scheduler, persistence, replay envelope, outcome application (achievements, stars, progress).
- **Persistence keys:** `bb.settings.v1`, `bb.progress.v1` (`{data, check}` FNV checksum; rejected if it does not verify), `bb.snapshot.v1` (cfg + log + hash + def, cleared on finish), `bb.funnel.v1` (anonymous local funnel events: boot, start, tutorial step, round end, retry, undo, settings change, quit, error category; capped at 200). Storage falls back to an in-memory map when `localStorage` is unavailable.
- **Determinism:** three seeded streams — rules (`seed ^ STREAM_RULES`), audio (`sfx:<event>:<seed>`, `music:<seed>`), particles (position + time). `tests/replay.test.mjs` proves identical hashes for identical seed + commands across 30 games.
- **Renderer layers:** environment 0, gameplay 1 (the only raycast layer; invisible box volumes per point, rail and off trays), selection 2, effects 3 (particles have a no-op `raycast`). Context loss rebuilds GPU resources from theme + last state.
- **Quality model:** see **Graphics** in §8. `createRenderer` exposes `setGraphics(saved)` (idempotent per settings JSON; resizes/enables the shadow map and recompiles lit materials, rebuilds board and markers when the detail tier changes, swaps the environment, re-keys the post chain) and `graphicsInfo()` (GPU, detected preset, resolved tiers, pixels, fps, adaptive scale, post failure). The old `quality` setting migrates once (`medium` → Balanced). The canvas is created with MSAA (used directly only by Low); the composer's half-float target uses 4× MSAA for the `msaa` tier. Hidden tabs stop the RAF loop. Draw calls stay under ~200 (points merged into three meshes, hit volumes, ≤ 46 markers (rings merged into the marker mesh on Low/Balanced), frame, trays, particles).
- **E2E drive.** `tests/e2e.mjs` starts its own static server on an ephemeral port (404 for `/api*` and `/ws*`; any such request fails the run), launches headless Chrome with SwiftShader, and plays a complete practice duel at 1280×800 and 390×844 (touch) purely through visible DOM: title `Play now`, settings (reduced motion, low quality), the Graphics section (Ultra, Low, High, a bloom override, reload persistence, preset clears overrides), `Roll`, arrow-key roving focus + `Enter` on mirror buttons, `Pass`, `Hint`, `Undo`, pause → settings → resume, cube `Accept`, then verifies the results table and returns to the menu; each viewport then runs a signed-in Language step (stubbed StarHermit API, `tests/starhermit-e2e.mjs`): `GET /api/v1/me/language` → `fr-CA` makes the title French ("Jouer") and Automatic read "Automatique — Français (Canada)"; a practice table is paused, Settings → Language → Italiano relabels Settings in place and PUTs `ui.language`, Report a problem posts a bug report, Done returns to the Italian pause dialog, tray and turn indicator ("Tu: tiro") with the same turn, and Automatic returns to fr-CA (bearer-token requests that bypass `page.route` at unload are not counted as own-server calls); any console error, console warning or page error fails the run. Chrome is launched without `DISPLAY`/`WAYLAND_DISPLAY` so a stuck desktop compositor cannot hang GPU start-up.

## 14. Testing and acceptance criteria

`npm test` (`node --test tests/*.test.mjs`, 52 tests, no dependencies):
- `platform.test.mjs`: the SDK in a sandbox with a stubbed `fetch` drives `js/account.js` — no requests standalone; token read and fragment stripped; nickname; settings patch of changed keys; cloud-save round trip through `game:<slug>`; control overrides; invite link; sign-out on refused renewal; account strings in all nine locales; a refused (412) write re-reads the cloud copy for the conflict handler; `mergeProgress` keeps the better record from each device; every `js/i18n` key and every stage, lesson step, challenge, achievement, theme and mastery title exists in all nine locales.
- `rules.test.mjs`: layouts, validation messages, doubles, hits, rail priority, higher-die rule, bear-off gates, win breakdown, gammon/backgammon factors, cube offer/accept/ownership/decline payout, pass legality, out-of-turn and malformed commands, concede in duel and circuit, move-limit tiebreak, serialization round-trip, marker conservation, circuit direction, layout helper.
- `replay.test.mjs`: 30-game hash reproducibility, AI-vs-AI termination bound, malformed-command fuzzing, hash divergence across seeds, envelope invariants.
- `content.test.mjs`: every lesson/stage/challenge/daily passes `validateContent`; counts (6/40/8/5); sampled tables terminate under the steady AI; daily determinism; achievement key format; practice constraints; stable journey seeds; scripted dice stay legal.
- `gfx.test.mjs`: hardware level → preset (SwiftShader / `Radeon Graphics` / UHD → Low, Iris Xe → Balanced, RTX 3070 → High, RTX 4080 / 5090 → Ultra, a mobile Adreno 740 or RTX 5090 → Balanced at most), the per-preset budget table, `resolve` with auto/explicit presets, overrides, invalid tiers, render-scale clamp, `choosePreset` clearing overrides, `describe`, and complete Graphics strings in all nine locales plus `pickLocale`.
- `server.test.mjs`: time endpoint, static hosting of launch file and assets, session create → command → snapshot → replay, invalid config rejection, AI answering rival seats.

`npm run test:e2e` is the browser playthrough described in §13; `npm run smoke` boots `server.js` on port 8391 and checks the launch file, every client asset, the time API and one session round-trip.

QA bar (checkable):
1. A new player reaches a rolling table in one click from the title and is told what to do by the objective line, the turn indicator and the enabled buttons; lessons instruct step by step.
2. Every feature listed in §5–§7 is reachable from visible controls at 1280×800 and 390×844 in both orientations; nothing critical sits under browser chrome (safe-area offsets) and no text is clipped (tray wraps, screens scroll).
3. The console shows no errors or warnings during a full game (e2e asserts this).
4. All 21 clips in `sfx/manifest.txt` exist, are 48 kHz mono Opus, and are bound to an event id present in `js/audio.js` (`tools/audit_game_assets.py` passes).
5. `node --check` passes on every shipped JS/MJS file.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` | Title-screen hero image (1200×672, 57 KB) | FLUX.2 klein, seed 2712, 30 steps | generated in this pass, wired (`showTitle`, `.bb-key-art`, hides on load error) |
| `assets/results-victory.webp` | Results illustration on a win (640×400, 20 KB) | FLUX.2 klein, seed 4101 | generated in this pass, wired (`showResults`) |
| `assets/results-road.webp` | Results illustration on a loss (640×400, 20 KB) | FLUX.2 klein, seed 4102 | generated in this pass, wired (`showResults`) |
| `coverart.png` | Store cover 1200×675, 256-colour PNG (345 KB) | Scaled from the key art | replaced the generic placeholder in this pass |
| `icon.png`, `favicon.svg` | Icons | authored earlier | shipped |
| `sfx/*.opus` × 16 (ack, roll, move, hit, bearOff, enter, double, accept, decline, invalid, noMoves, turn, win, lose, unlock, tick) | Event cues | MOSS-SoundEffect v2.0 | shipped; `tick` newly bound to focus movement |
| `sfx/dice-doubles.opus`, `marker-select.opus`, `undo-slide.opus`, `table-open.opus`, `journey-stars.opus` | New cues: doubles, selection, undo, table open, stars | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired in `audio.js` and `main.js` with synth fallbacks |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical table / generator input / generator output | hand-written / tool | shipped, in sync (21 entries each) |
| 3D models, character animation | — | TRELLIS / Kimodo | not called for: all geometry is procedural and there is no humanoid |
| `vendor/three.module.min.js`, `vendor/three/addons/` | Renderer and post-processing / environment addons (r160) | Three.js (MIT) | shipped |

## 16. Known limitations

- `server.js` serves every file under the game root, including `tests/` and `tools/`; it does not refuse dotfiles.
- `concede` exists in the rules and the server whitelist but has no UI control; `Leave table` saves a snapshot instead.
- The thinking clock and Blitz goal only track seat 0; in pass-and-play the second human's time is not measured and hints/undo act for whichever human seat is active.
- Stacks above five markers show a lifted top disc but no count on the canvas; the exact count is only in the rail rows and the board mirror.
- The daily is marked complete only on a win, and "ranked" has no leaderboard behind it.
- The sharp AI's full-turn search on four-caravan doubles can take a noticeable fraction of a second on slow phones.
- `Copy replay envelope` needs clipboard permission; without it only the final hash is shown in a toast.
- Leather and wood are seeded procedural canvases (512 px at most), not scanned materials.
- The anti-aliasing `off` tier only removes post-process AA; when no post chain runs, the canvas keeps the browser's multisampling (it is fixed at context creation).
- The title screen shows the live board faintly behind its panel; there is no separate menu hero scene.

## Design intent not yet implemented

- Presence, activity start/end, a separate daily leaderboard, and platform-side achievement unlocks.
- A concede control in the pause dialog.
- Refusing `tests/`, `tools/` and dotfiles in `server.js`.
- A rendered brass stakes cube on the board (currently a HUD badge).

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.


## Sound and frame-rate options

The options panel includes Sound controls for master, music, effects and UI volume, a mute that preserves volume levels, and an Auto or manual concurrent-sound limit (1–64). Changes apply immediately with perceptual volume curves. A shared allocator bounds Web Audio and media playback, including loops and scheduled sources. Graphics includes Auto display refresh or a custom maximum frame rate from 1–1000 FPS; rendering is paced independently of simulation and input. Preferences persist locally, with FPS stored per detected GPU, and reconcile with Starhermit settings when signed in. The controls support keyboard and touch input and the supported English, Spanish, German, French, Portuguese and Italian locales.
