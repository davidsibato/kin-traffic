/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional raster tile URL template, e.g. a provider you have rights to use. Defaults to OSM tiles. */
  readonly VITE_TILE_URL?: string;
  /** Optional Overpass API endpoint for browser-side road downloads. */
  readonly VITE_OVERPASS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
