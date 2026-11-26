# Kin Traffic MVP: Kinshasa congestion simulation

An interactive TypeScript web app for exploring congestion in Kinshasa, and testing whether changing traffic signals improves flow during busy periods.

**All traffic numbers are simulated estimates from assumed demand.** No live or observed traffic feed is included.

## 1. What is real, simulated, or needs an external source

| Element | Status | Source / requirement |
|---|---|---|
| Basemap | **Real map** | OpenStreetMap raster tiles, shown with MapLibre GL JS. No API key. |
| Road network for the simulation | **Real roads** once imported | OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL 1.0). Downloaded in the browser from the panel, or prebuilt with `npm run import:osm`. |
| Traffic counts or speeds | **None** | Needs observed counts or a licensed feed for Kinshasa. None is configured. |
| Demand, turning, compliance, headways, speeds | **ASSUMED** (labelled in the UI) | Model parameters. Not calibrated. |
| Signal timing | **User-defined** | OSM has no signal timing. Imported signals get a default plan. |
| Incidents | **User-configured** | A speed reduction on one link |
| Vehicles and pedestrians | **2D sprites with shading** | Not 3D models |
| Travel time, delay, queue, throughput | **Simulation estimates** | Model output, not observation |

Google Maps is not used. Its terms do not allow exporting its road network or traffic data for simulation, and the OSM roads are the data source the simulation needs anyway.

## 2. Architecture and data flow

```
OSM extract (public/data/*.json) ──► Simulation core (sim.ts, signals.ts)  ──► Metrics
   ▲ npm run import:osm                 ▲ demand, signals, incidents (user/assumed)
                                        │
MapLibre + OSM raster tiles ◄── camera ─┴──► drawScene (draw.ts) on a canvas above the map
   (mapview.ts)                    project(lat,lng) every frame
```

- **Simulation core** (`sim.ts`, `signals.ts`, `network.ts`, `scenario.ts`): no DOM, deterministic for a given seed, runs headlessly.
- **Map and drawing** (`mapview.ts`, `draw.ts`): MapLibre handles pan, zoom, tilt and rotation. The simulation canvas is projected with the map's own projection each frame, so it stays aligned.
- **Controls and panel** (`main.ts`).

### Model (MVP level)

- **Discrete time, 0.5 s steps.** Cars and motorcycles follow each other with the Intelligent Driver Model (IDM). Motorcycles have shorter gaps and a 10% higher desired speed to represent lane filtering. This is an assumption.
- **Signals** are fixed-time, two-phase (A = roughly north-south, B = roughly east-west), with amber and all-red lost time. A compliant driver stops for red or amber if they can stop comfortably. A non-compliant driver ignores it. Red crossings are counted.
- **Junction discharge** uses a headway per lane (cars 1.9 s, motos 1.2 s, assumed). This is the main capacity limit.
- **Queues** form naturally, and spillback happens when downstream links fill.
- **Pedestrians** reduce green time by an assumed amount. Walkers are drawn only for visual reference.
- **Baseline vs intervention** use the same seed and demand streams. Only signal plans and any incidents differ.

## 3. Setup

Requirements: Node.js 18+ (tested on 22) and npm.

```bash
cd kin-traffic
npm install
npm run dev          # open http://localhost:5173
```

The map appears at once. In the panel, check the box (default: Échangeur in Limete to Gare Centrale) and click **Load roads**. The app downloads the main roads (trunk, primary, secondary, tertiary) from OpenStreetMap through the public Overpass API, directly in the browser, and starts the simulation. Keep the box small (the app refuses areas larger than about 0.15 × 0.1 degrees) because the public server limits large queries.

### Faster start: commit a prebuilt road file

For friends testing, a prebuilt file loads instantly and avoids Overpass rate limits:

```bash
npm run import:osm -- -4.39 15.30 -4.29 15.36     # South West North East
git add public/data/kinshasa-osm-network.json
```

The app uses this file when it exists and skips the in-browser download. The bounding box must be given. The importer will not guess an area.

Other commands:

```bash
npm run build     # type-check and bundle to dist/
npm run verify    # headless checks, including the OSM parser
```

### Deploy to Vercel (shareable link for friends)

The project is a static Vite site, so Vercel detects it automatically:

1. Put the `kin-traffic` folder in a GitHub repository.
2. In Vercel, choose **Add New → Project**, import the repository, and deploy. Build command `npm run build` and output directory `dist` are the defaults.
3. Share the `*.vercel.app` URL.

Or from a terminal: `npm i -g vercel`, then `vercel` in the project folder, then `vercel --prod`.

Notes for sharing:
- **Tiles:** the default map uses OpenStreetMap's public tile server, whose usage policy limits heavy use. For many testers, set `VITE_TILE_URL` in Vercel's project settings to a tile provider you have rights to use.
- **Overpass:** each "Load roads" click calls the public Overpass server. Commit the prebuilt road file (above) so testers never need it.
- **Browser support:** the map needs WebGL. If it is unavailable, the panel says so and the simulation still runs.

### Tile source

Set `VITE_TILE_URL` (see `.env.example`) to change the basemap tiles. Set `VITE_OVERPASS_URL` to use a different Overpass endpoint.

## 4. Using the app

- **Playback:** Play/Pause, Reset, speed 1×–60×, and the simulated clock.
- **Scenario:** Baseline or Intervention is shown live.
- **Demand and behaviour:** sliders apply to both scenarios.
- **Signals:** choose a junction, set cycle length and green split, then add, update, or remove. These edits change only the intervention. "Move" means remove and add elsewhere.
- **Incidents:** pick a link, set its speed factor, and toggle it. Applies to both scenarios.
- **Live metrics** and **baseline vs intervention** (one simulated hour, same seed and demand).

## 5. Verification steps

1. **Map:** the map shows immediately. Load roads for the default box, and the map zooms to the network.
2. **Camera:** drag to pan, scroll to zoom, right-drag or use the compass control to tilt and rotate. Vehicles and signals stay on the roads.
3. **Playback:** Pause/Play stops and resumes the clock. Reset clears the network.
4. **Traffic:** after about 10 simulated minutes, vehicles fill the roads. Raise car arrivals and confirm the average queue rises.
5. **Signals:** in Intervention, add a signal, confirm its lights appear, then remove it. Baseline stays unchanged.
6. **Incidents:** toggle one and confirm the link shows a dashed line and congestion rises.
7. **Comparison:** run it twice with the same settings. The arrivals row should match in both columns, and the results should be identical.
8. **Automated core:** `npm run verify` prints PASS for every check and exits with code 0.

Steps 1–6 are manual browser checks. They have not been run in a browser yet.

## 6. Known limitations

1. **Not calibrated or validated.** All demand and behaviour parameters are assumptions.
2. **Unsignalised junctions have no gap-acceptance model.** Adding signals often increases delay in this MVP. That is a model limit, not a finding about Kinshasa.
3. **No lane-level model.** Lane count affects only discharge headway.
4. **Turning proportions are global**, not per junction.
5. **Fixed-time signals only.**
6. **Simplified origin-destination.** Vehicles enter at boundary nodes and leave randomly after a minimum distance.
7. **Imported dead-ends become entry and exit points.** This is an approximation, and clipped bbox edges can produce false entries.
8. **OSM signal timing is a default**, not observed.
9. **Browser UI not automated.** The simulation core passes headless checks. The map and panel have been type-checked and built, but not driven in a browser.
10. **OSM import has not run here.** The build environment cannot reach Overpass. The importer passes a syntax check and needs a first run on your machine.
11. **Performance** is not benchmarked. Very large extracts may need a web worker and spatial indexing.
12. **2D sprites**, not 3D vehicles.

## 7. Next steps

1. Collect observed data: turning counts at 5–10 junctions (video counting works), peak-hour travel times on a few corridors, and signal timings.
2. Calibrate headways and compliance against those counts. Hold some junctions out for validation.
3. Add gap acceptance for unsignalised junctions, so signal comparisons are fair.
4. Add per-approach turning counts and lane-level detail.
5. Consider a 3D layer on the map if you need real 3D vehicles.
6. Add scenario export (JSON with seed, network source and data-status) for reproducible comparisons.

## Project layout

```
kin-traffic/
├── index.html · package.json · tsconfig.json · .env.example · README.md
├── public/data/                 generated by npm run import:osm
├── scripts/
│   ├── import-osm.mjs           OSM extract via Overpass (bbox required)
│   └── verify-sim.ts            headless checks (npm run verify)
└── src/
    ├── main.ts                  UI, playback, comparison table
    ├── mapview.ts               MapLibre + OSM basemap and camera projection
    ├── draw.ts                  canvas drawing of roads, signals, vehicles, pedestrians
    ├── sim.ts                   simulation core
    ├── signals.ts               fixed-time signals and pedestrian loss
    ├── network.ts               road graph, validation, geometry helpers
    ├── scenario.ts              headless runs and comparison
    ├── rng.ts · types.ts · env.d.ts · style.css
```
