import maplibregl from 'maplibre-gl';
import type { Projector } from './draw';
import type { Bbox } from './osm';

/** A basemap plus a transparent canvas on top, onto which the simulation is drawn. */
export interface MapView {
  label: string;
  canvas: HTMLCanvasElement;
  ready(): boolean;
  project: Projector;
  beginFrame(ctx: CanvasRenderingContext2D): void;
  /** Moves the camera to show a bounding box (south, west, north, east). */
  fit(b: Bbox): void;
}

const TILE_URL = import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/**
 * OpenStreetMap basemap rendered with MapLibre GL JS (open source, no API key).
 * The map shows as soon as the page loads, before any road data is downloaded.
 *
 * Tiles: the default is OSM's public tile server, whose usage policy limits heavy use.
 * For wider sharing, set VITE_TILE_URL to a tile provider you have rights to use.
 */
export function createMapView(host: HTMLElement, initial: Bbox): MapView {
  const map = new maplibregl.Map({
    container: host,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: [TILE_URL],
          tileSize: 256,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [(initial[1] + initial[3]) / 2, (initial[0] + initial[2]) / 2],
    zoom: 13,
    pitch: 45, // tilted by default; right-drag or the compass control changes pitch and bearing
    bearing: 0,
    maxPitch: 70,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  let loaded = false;
  map.on('load', () => {
    loaded = true;
  });

  const fit = (b: Bbox) => {
    map.fitBounds(
      [
        [b[1], b[0]],
        [b[3], b[2]],
      ],
      { padding: 40, duration: 0 },
    );
  };
  fit(initial);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
  host.appendChild(canvas);

  // MapLibre re-projects on every render, and the simulation canvas is redrawn every frame, so they stay aligned.
  const project: Projector = (lat, lng) => {
    const p = map.project([lng, lat]);
    return { x: p.x, y: p.y };
  };

  return {
    label: `OpenStreetMap basemap (MapLibre GL JS) · tiles: ${TILE_URL}`,
    canvas,
    ready: () => loaded,
    project,
    beginFrame: (ctx) => ctx.clearRect(0, 0, host.clientWidth, host.clientHeight),
    fit,
  };
}
