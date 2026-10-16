"""Regenerates tests/fixtures: a tiny deterministic 5-date Sentinel-2-like stack (red, nir, scl) on a 32x32,
10 m UTM 43N grid. Values are chosen so the expected median/mask result is known by hand:

  left half  (x<16): red DN per date [1000,2000,1500,3000,2500], SCL [4,4,4,9,3]  -> valid dates 0,1,2 -> median red 1500
  right half (x>=16): red DN per date [1000,2000,3000,4000,2000], SCL [4,8,4,10,4] -> valid dates 0,2,4 -> median red 2000
  bottom rows (y>=28): SCL 9 on every date -> no valid observation -> NaN in the composite
  block y9-11,x7-9: nir DN is 0 (no-data) on date 0 -> that date is dropped there (red median 1750, nir 3500)
nir DN = 2*red DN (so NDVI of the median is exactly 1/3 where nir median = 2*red median).
"""
import json
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from pyproj import Transformer

OUT = Path(__file__).parent / "fixtures"
X0, Y0, RES, N = 420000.0, 3445000.0, 10.0, 32
DATES = ["2026-09-02", "2026-09-07", "2026-09-12", "2026-09-17", "2026-09-22"]
RED_L, SCL_L = [1000, 2000, 1500, 3000, 2500], [4, 4, 4, 9, 3]
RED_R, SCL_R = [1000, 2000, 3000, 4000, 2000], [4, 8, 4, 10, 4]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tf = Affine(RES, 0, X0, 0, -RES, Y0)
    to_ll = Transformer.from_crs(32643, 4326, always_xy=True).transform
    w, n = to_ll(X0, Y0 - N * RES)
    e, nn = to_ll(X0 + N * RES, Y0)
    items = []
    for i, d in enumerate(DATES):
        red = np.empty((N, N), np.uint16)
        scl = np.empty((N, N), np.uint8)
        red[:, :16], red[:, 16:] = RED_L[i], RED_R[i]
        scl[:, :16], scl[:, 16:] = SCL_L[i], SCL_R[i]
        scl[28:, :] = 9
        nir = (red * 2).astype(np.uint16)
        if i == 0:
            nir[9:12, 7:10] = 0
        assets = {}
        for name, arr in (("red", red), ("nir", nir), ("scl", scl)):
            fn = f"{d}_{name}.tif"
            with rasterio.open(OUT / fn, "w", driver="GTiff", width=N, height=N, count=1, dtype=str(arr.dtype),
                               crs="EPSG:32643", transform=tf, nodata=0, compress="deflate") as dst:
                dst.write(arr, 1)
            assets[name] = {"href": fn, "type": "image/tiff; application=geotiff", "roles": ["data"],
                            "raster:bands": [{"data_type": str(arr.dtype), "nodata": 0}]}
        items.append({
            "type": "Feature", "stac_version": "1.0.0", "id": f"FIX_{d}", "collection": "sentinel-2-l2a",
            "bbox": [w, n, e, nn],
            "geometry": {"type": "Polygon", "coordinates": [[[w, n], [e, n], [e, nn], [w, nn], [w, n]]]},
            "properties": {"datetime": f"{d}T05:40:00Z", "eo:cloud_cover": 10.0, "proj:epsg": 32643},
            "assets": assets, "links": [],
        })
    (OUT / "items.json").write_text(json.dumps({"bbox": [w, n, e, nn], "items": items}, indent=1))


if __name__ == "__main__":
    main()
