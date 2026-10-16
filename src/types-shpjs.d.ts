declare module 'shpjs' {
  /** Parses a zipped shapefile (ArrayBuffer) or a URL; reprojects to WGS84 using the .prj. */
  export default function shp(
    input: ArrayBuffer | Uint8Array | string,
  ): Promise<GeoJSON.FeatureCollection | GeoJSON.FeatureCollection[]>
}
