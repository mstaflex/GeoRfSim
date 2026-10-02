# GeoRfSim

A 3-D viewer that flies a drone over a landscape and shows, live, what happens
to its radio links. You pick the terrain, the airframe, the flight pattern, the
speed and the height. GeoRfSim draws the flight track coloured by link quality
and breaks the received signal down into what helps and what hurts: line of
sight, terrain, buildings, vegetation, ground reflection, scattering,
shadowing, antennas, interference and Doppler. It also judges ten radio
technologies, from LoRa to 5G mmWave, on the same flight.

You can also draw your own waypoint flight plans on the map, define your own
airframes, or take the sticks and fly the drone yourself.

It does **not** trace rays. Geometry only decides *whether* the direct path is
clear, clipped, through foliage or blocked. Established models then decide
*how much* each mechanism costs. A Rician/Rayleigh fading process turns the
result into the signal distribution of the last 5 seconds.

![City scenario: street-canyon flight at 15 m, NLOS behind buildings](docs/urban.jpg)

![Open farmland: vertical profile up to 400 m – the ground reflection fades as the drone climbs](docs/open.jpg)

## Starting it

```bash
docker compose up --build        # then open http://localhost:8080
```

The container is bound to `127.0.0.1` only. Put a reverse proxy with TLS in
front of it to expose it. Any static server works for development, because
there is no build step and no dependency:

```bash
python3 -m http.server 8000 --directory app
```

Tests (Node ≥ 20, no packages to install):

```bash
npm test                          # = node --test tests/*.test.js
```

## Using it

Everything applies immediately. There are no "apply" buttons.

| What | How |
| --- | --- |
| Scenario, drone, pattern | selects in the top bar (or keys `1`…`6` for scenarios) |
| Speed, height, pattern size | sliders. Height is a log slider (1 m – 1 km) with presets 2 / 10 / 30 / 60 / 120 / 300 m |
| Play, pause, time warp | `Space`, `,` / `.` (×0.25 … ×20), `R` restarts and clears the track |
| Camera | drag: orbit · right-drag or Shift: pan · wheel: zoom · double-click: look there |
| Camera modes | Orbit, Follow, Chase, Top, Pilot view, FPV (`C` cycles, `F` `T` `P`) |
| Flight profiles | ✎ next to *Pattern*: waypoint plans drawn on the map (`E` toggles map editing). See below |
| Drone profiles | ✎ next to *Drone*: your own airframes, based on a built-in one |
| Free flight | *Free flight* button or `G`: fly with keyboard, game pad, RC transmitter or the on-screen sticks |
| Move things | "Move: Pattern centre / Pilot / Cell site", then click the 3-D view or the minimap |
| Technology in detail | click a row in the table, or `↑` / `↓` |
| Antennas | ground and drone antenna selects in the *Antennas* card. *Auto* uses each technology's typical antenna |
| Settings (`S`) | height scale (log / linear / true), h₀, exaggeration, terrain relief, tree size, layers, track colouring, pilot antenna height, interference, cell load, shadowing, fading, obstacle avoidance |
| Region | EU / US switch above the table (frequencies and Tx powers) |

The URL carries the scenario, drone, pattern, speed, height, size, centre,
technology and antennas, so a link reproduces the setup. When a custom drone or
a flight profile is in use, the link carries it too, so the recipient gets
them without any files. Display settings, flight profiles, custom drones and
free-flight preferences are remembered in `localStorage`, in this browser only.

### What you see

* **3-D view.** The flown track is coloured by link margin, by path state
  (LOS, Fresnel zone clipped, vegetation, NLOS terrain, NLOS buildings) or by
  height. Drop lines and a ground shadow show the 3-D position. The direct ray
  to the ground node is drawn as a curve coloured by what it passes through.
  The ground-reflection path appears when it matters. Translucent lobes show
  both antenna patterns, oriented with the airframe's attitude. Hidden parts
  (a drone under the canopy, a track behind buildings) stay visible as an
  x-ray.
* **Link card.** SINR, Rx power, path loss, distance, elevation, Rician K
  (model and fitted), Doppler shift and spread, coherence time, delay spread
  and coherence bandwidth, current mode/MCS, throughput and PER.
* **Influences.** Each mechanism's contribution in dB relative to free space,
  plus how the received power splits into direct, ground-reflected and
  scattered parts.
* **Distribution · last 5 s.** A histogram (or CDF on a log-probability axis)
  of the narrow-band single-antenna SINR, overlaid with the Rician theory for
  the current K. The *effective* SINR after antenna diversity and
  wideband/frequency diversity is shown next to it. 1 % and 10 % points are
  marked, together with the fade depth and the diversity gain.
* **SINR · last 30 s.** Instantaneous vs. large-scale SINR against the most
  robust mode's threshold.
* **Antennas.** The elevation cut of both antennas in the plane of the link,
  with the current direction marked.
* **Reference models.** Free space, this simulation, 3GPP TR 36.777 /
  TR 38.901 (LOS/NLOS and P(LOS)) and Al-Hourani et al. for the same geometry.
* **Technology table.** Per technology: band and bandwidth, path (with its
  state), mean and 10 % SINR, Doppler shift and spread relative to the
  subcarrier spacing, PER, throughput (DL/UL for cellular), and a verdict
  (*Excellent … No link*) with its reasons.

## Flight profiles, drone profiles and free flight

![Flight profile editor: a street survey with alternating heights and a 10 s hold, edited directly in the 3-D view](docs/profiles.jpg)

**Flight profiles** are waypoint plans. Every waypoint has a height above
ground, the speed of the leg that starts there and an optional hold (hover
time). At the last waypoint the drone loops back to the first, flies the plan
back and forth, or stops and hovers. Open the editor with ✎ next to the
pattern, switch on *Edit on map* (`E`) and click on the ground (Top view, `T`,
is easiest). Drag a marker to move it. Right-click or `Delete` removes it. The
table edits the numbers, and *All heights / All speeds* set every waypoint at
once. The planned path is drawn with its rounded corners while the editor is
open, and edits apply to the running flight immediately.

* Corners are flown with the turn radius the airframe needs at that speed.
  Multirotors stop exactly on hold points, and they stop and turn on hairpins
  (> 150°). Speeds change at the airframe's acceleration, and the drone brakes
  in time for a hold.
* Fixed wings cannot hold or stop, so their plans always loop and holds are
  ignored. The editor warns about this, about legs faster than the drone, about
  climbs steeper than its climb rate and about waypoints off the map.
* *New from current pattern* turns any built-in pattern into editable
  waypoints. *New from last free flight* turns your own flight into a
  repeatable plan (Douglas-Peucker simplification of the flown track, with the
  speeds you flew).
* Profiles belong to the scenario they were drawn on. Selecting one made for
  another map switches to that map. Profiles appear in the *Pattern* select and
  travel as JSON files (*Export* / *Import*) or inside a link (*Copy link*).

**Drone profiles.** Built-in airframes are read-only templates. *Duplicate*
(or *New*) gives an editable copy: type (multirotor, fixed wing, VTOL), look,
cruise / max / stall speed, climb rate, acceleration, max tilt or bank, size
and the antenna on board (*Auto* keeps each radio's typical antenna). Below the
fields the editor shows what follows from them: turn radius at cruise and at
max speed, stopping distance, turn rate at max bank and the largest Doppler
shift at 868 MHz, 2.4 GHz and 5.8 GHz. Changes apply live when that drone is
flying.

![Free flight behind a ridge: the ELRS control link is gone, so the failsafe takes over and flies home](docs/freeflight.jpg)

**Free flight** (`G`) hands you the sticks, starting from wherever the drone
is. The on-screen display shows altitude, vertical speed, speed, heading,
distance and direction home, the control link quality and the flight mode,
plus both sticks.

| Input | Throttle / yaw | Pitch / roll | Notes |
| --- | --- | --- | --- |
| Keyboard (Mode 2) | `W` `S` / `A` `D` | `↑` `↓` / `←` `→` | `Shift` for fine control. A fixed wing's throttle stays where you leave it |
| Game pad, Mode 2 or Mode 1 | sticks | sticks | Y / △ toggles return home |
| RC transmitter over USB (EdgeTX, OpenTX …) | AETR or TAER channel order | | appears as a joystick. *Invert pitch* if needed |
| On-screen sticks | drag the left stick | drag the right stick | touch or mouse. Phones get large thumb sticks |

* Multirotors fly like a GPS drone in position mode. The sticks command
  velocity, the airframe accelerates within its limit and tilts accordingly,
  and centred sticks hold position and altitude. Fixed wings fly coordinated
  turns (turn rate = g·tan φ / v) and never drop below stall speed.
* Ground and buildings are solid, and the drone bumps off walls. Tree crowns are
  not solid, so under-canopy flight is possible. Altitude is barometric, so
  hills come closer when you fly towards them.
* **Return home** (`H`, or the button) climbs to at least 40 m and over
  whatever stands in the way, flies back and lands 6 m from the pilot. A fixed
  wing circles overhead instead. Moving a stick takes control back.
* **Failsafe.** With *failsafe RTH* on, the chosen control link (ELRS 2.4 GHz
  by default, any technology can be picked) is watched. When it loses more than
  90 % of its packets for a second, the drone stops hearing the sticks and
  returns home. This comes from the simulated link, so a ridge, a building or
  a long distance triggers it, not a timer.
* The **FPV** camera rides on the airframe, tilted up 15°. The horizon rolls and
  pitches with the drone.
* Leaving free flight (`G`) resumes the selected pattern at the point closest
  to the drone. The jump is left out of the drawn track. *Save as flight
  profile* keeps the flight.

## Height scale

Heights above ground are drawn logarithmically: `y = H · log10(1 + h / h₀)`.
A pilot at 1.5 m, a 20 m canopy, a street canyon and a drone at 400 m all stay
readable on a map several kilometres wide. Terrain relief is linear (with an
adjustable exaggeration). The mapping is monotonic for every ground point, so
"above / below the canopy" is always drawn correctly. That is also why the
straight direct ray appears as a curve. Tree crowns are widened with the
vertical scale and forest instances are thinned accordingly, so trees appear
larger than life instead of as needles. Settings switches to linear or true
scale.

## Scenarios

| # | Scenario | Shows |
| --- | --- | --- |
| 1 | Open farmland · high altitude | Fields, small woods, hedgerows, a lake. Vertical profile to 400 m: the two-ray ground reflection and scattering lose influence with height, K rises |
| 2 | Forest · through the woods | Mixed forest with a forest road. Under-canopy flight at 6 m vs. above-canopy. Vegetation loss and Rayleigh fading |
| 3 | City · street canyons | Blocks, towers, a park, a river. A street route switches between LOS and NLOS at every corner. Rooftop cell site |
| 4 | Suburb · houses & gardens | Low-rise houses with garden and street trees. Scattering everywhere, clear LOS from ~30 m |
| 5 | Hills & valley · terrain shadowing | A forested ridge between pilot and village. Knife-edge diffraction behind the crest |
| 6 | Lake · over-water reflection | Calm water is a near-perfect mirror. Two-ray interference dominates at low height |

Every world is procedurally generated from a fixed seed: terrain, land use,
building blocks, trees and routes. Generation takes about 0.1 s.

## Drones and patterns

| Drone | Type | Cruise / max | Accel. | Notes |
| --- | --- | --- | --- | --- |
| Mini quad (<250 g) | multirotor | 8 / 16 m/s | 5 m/s² | 30° max tilt |
| Prosumer quad (Mavic class) | multirotor | 12 / 21 m/s | 6 m/s² | |
| Enterprise quad (M350 class) | multirotor | 10 / 23 m/s | 5 m/s² | |
| FPV racer (5-inch) | multirotor | 22 / 40 m/s | 15 m/s² | 60° tilt: strong attitude effects |
| Heavy-lift hexa (agri) | multirotor | 6 / 10 m/s | 3 m/s² | |
| Fixed-wing mapper | fixed wing | 16 / 25 m/s | 2.5 m/s² | min 11 m/s, banks in turns, cannot hover |
| VTOL long-range | VTOL | 22 / 30 m/s | 3 m/s² | |

Your own airframes and waypoint plans are made in the editors described above.

Patterns: hover, out & back (range test from the pilot), orbit, figure 8,
survey (lawnmower), vertical profile, spiral climb, and a scenario route
(streets, forest road, ridge crossing, lake loop). Turn radii follow the
airframe (`tan φ = v²/(g·R)`). Multirotors pitch with speed and bank in turns,
and that attitude rotates the antennas. Obstacle avoidance lifts the path over
roofs and tree crowns at the airframe's climb rate but allows under-canopy
flight below the crown base. Height changes are flown at the climb rate, not
teleported.

## Technologies

| Technology | Ground node | Band · BW | Tx EU / US | PHY abstraction |
| --- | --- | --- | --- | --- |
| ELRS 2.4 GHz | pilot → drone | 2.44 GHz · 812.5 kHz | 20 / 24 dBm | LoRa SF6, 250 Hz packets |
| ELRS / Crossfire 868·915 | pilot → drone | 868 / 915 MHz · 500 kHz | 14 / 27 dBm | LoRa SF7, 100 Hz |
| SiK telemetry 433·915 | drone → pilot | 433 / 915 MHz · 150 kHz | 10 / 20 dBm | GFSK 64 kbit/s |
| LoRa 868·915 (ADR) | drone → pilot | 868 / 915 MHz · 125 kHz | 14 / 20 dBm | SF7…SF12, adaptive |
| Wi-Fi 2.4 GHz (11n) | drone → pilot | 2.437 GHz · 20 MHz | 20 / 27 dBm | MCS0…7, preamble-only channel estimate |
| Digital video 5.8 GHz | drone → pilot | 5.8 GHz · 20 MHz | 14 / 28 dBm | OFDM with pilots (OcuSync-like, numerology assumed) |
| Analog FPV 5.8 GHz | drone → pilot | 5.8 GHz · 18 MHz | 14 / 23 dBm | FM threshold 10 dB |
| LTE 800 (B20) | cell ⇄ drone | 806 MHz · 10 MHz | 46 dBm BS / 23 dBm UE | CQI 1…15 |
| 5G NR 3.5 GHz (n78) | cell ⇄ drone | 3.6 GHz · 40 MHz | 46 / 26 dBm | 256QAM CQI, massive-MIMO beams with limited vertical scan |
| 5G NR 26 GHz (n258) | cell ⇄ drone | 26 GHz · 200 MHz | 33 / 23 dBm | 120 kHz SCS, beam-steered arrays |

Transmit powers and receiver figures are assumptions for comparison, not
certifications. They are listed in `app/js/rf/tech.js`.

## Models

Per technology and sub-step (≤ 50 ms of flight time):

```
P_mean = P_tx + G_ground + G_air − FSPL − L_terrain − L_buildings − L_vegetation − L_gas − L_pol + shadowing
r(t)   = √(P_mean·K/(K+1)) · (1 + Γ·e^{−jkΔ(t)}) · e^{jφ_LOS(t)} + √(P_mean/(K+1)) · g(t)
```

| Mechanism | Model |
| --- | --- |
| Free space | Friis |
| Line of sight | Geometric: the ray is checked against terrain, building and canopy rasters (~3–8 m) |
| Terrain | Single knife-edge J(ν), ITU-R P.526, at the dominant obstacle (a clipped Fresnel zone counts too) |
| Buildings | Rooftop knife-edge, capped by the 3GPP TR 36.777 / TR 38.901 NLOS excess loss, which stands in for street-canyon multipath |
| Vegetation | Weissberger's modified exponential decay over the foliage depth, saturating at the ITU-R P.833 maximum attenuation |
| Ground reflection | Two-ray model with Fresnel coefficients (ITU-R P.527 ground constants) and Ament roughness. Circular polarisation cancels it at steep angles |
| Scattering / fading | Rician with K(θ) = K₀·exp(2θ/π·ln(K₉₀/K₀)) per clutter class (Azari et al.), ranges after the NASA/Matolak air-ground campaigns. Obstructions remove the coherent part (→ Rayleigh). Sum-of-sinusoids generator with a Clarke/Jakes Doppler spectrum (Zheng & Xiao) |
| Shadowing | Log-normal. σ follows 3GPP TR 36.777 (height dependent in LOS). Gudmundson correlation over the flown distance |
| Antennas | 3GPP TR 38.901 parabolic patterns, half-wave dipole, steerable arrays. Polarisation mismatch from the airframe attitude. Diversity = selection combining |
| Wideband | MIESM over ~bandwidth / coherence-bandwidth independent sub-bands |
| Mobility & multipath | Doppler ICI ((π²/3)(f_D/Δf)²), channel aging (Jakes J0 correlation over the estimate interval) and energy beyond the cyclic prefix, as SINR ceilings |
| Cellular interference | 18 virtual hexagonal neighbour sites (3 sectors each) with 3GPP LOS-probability-weighted path loss and load. This is why drones high up see poor SINR |
| Unlicensed bands | Assumed noise rise in 2.4 / 5.8 GHz and sub-GHz ISM bands, growing with receiver height in built-up areas |
| PER & throughput | Mode/MCS tables (LTE/NR CQI, 802.11n, LoRa SF), link adaptation and a logistic PER waterfall (10 % at each threshold) |

References: ITU-R P.526-15, P.527-6, P.676-13, P.833-10; Weissberger (1982);
Ament (1953); 3GPP TR 36.777 V15.0.0, TR 38.901 V17, TS 36.213, TS 38.214;
Al-Hourani, Kandeepan & Lardner, *Optimal LAP altitude for maximum coverage*
(IEEE WCL 2014); Azari, Rosas, Chen & Pollin, *Ultra reliable UAV communication
using altitude and cooperation diversity* (IEEE TCOM 2018); Matolak & Sun,
*Air–ground channel characterization for unmanned aircraft systems* I–III
(IEEE TVT 2017); Gudmundson (1991); Zheng & Xiao (2003); Russell & Stüber
(1995).

**What it is not.** GeoRfSim is a teaching and comparison tool. Its worlds are
synthetic, and its parameters are typical values rather than measurements of a
particular site or radio. Use it to understand trends and orders of magnitude,
not for link planning or certification.

## Layout

```
app/
  index.html, css/style.css, favicon.svg
  js/
    main.js        UI controller: state, controls, render loop, panels, table
    sim.js         simulation engine: geometry, per-technology link, fading samples, 5 s stats, track,
                   path following (holds, leg speeds, acceleration), free flight and RTH hand-over
    flight.js      drone profiles, patterns, waypoint plans → paths, obstacle-safe height profile, attitude
    freeflight.js  manual flight dynamics (multirotor position mode, fixed wing), collisions, return home
    profiles.js    custom drones & flight profiles: validation, storage, link encoding, JSON, conversions
    world.js       procedural world: terrain, land use, buildings, trees, LOS profile queries
    scenarios.js   the six scenarios
    charts.js      2-D charts: distribution, history, antenna polar, minimap
    util.js        seeded RNG, noise, Bessel functions, formatting
    rf/            models.js, antennas.js, fading.js, tech.js, interference.js
    gfx/           renderer.js (WebGL2), camera.js, meshes.js, gl.js, mat.js
    ui/            flight-editor.js, drone-editor.js, pilot.js (free-flight input & OSD), dom.js
tests/             node:test unit tests (models, antennas, fading, worlds, simulation, profiles, free flight)
Dockerfile, nginx.conf, docker-compose.yml
```

The renderer is plain WebGL2. Heights are mapped to the log scale in the
vertex shaders, so changing the scale is a uniform update. Trees and buildings
are instanced, track and rays are instanced screen-space lines, and the track
uploads incrementally. While paused the view only redraws when something
changes.

## Hosting securely

The app has **no runtime dependencies**: no framework, no
npm or pip package at runtime, no CDN, no fonts from elsewhere, no tracking, no
cookies and no backend. That is what allows a strict Content-Security-Policy
without `unsafe-inline` or `unsafe-eval`. Profiles stay in the browser's
`localStorage`. Everything that comes in from storage, a link or an imported
file goes through a sanitizer that clamps every number and drops unknown
fields. Text is only ever inserted as text, never as HTML.

| Measure | Where |
| --- | --- |
| rootless nginx (uid 101), current base image | `Dockerfile` |
| read-only file system, all capabilities dropped, `no-new-privileges` | `docker-compose.yml` |
| bound to `127.0.0.1`, memory and process limits | `docker-compose.yml` |
| GET and HEAD only, everything else 405 | `nginx.conf` |
| strict CSP (`default-src 'none'`), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP | `nginx.conf` |

Rebuild regularly (`docker compose build --pull`) so nginx and Alpine patches
arrive.
