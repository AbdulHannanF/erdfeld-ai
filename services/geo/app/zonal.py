"""Zonal statistics over a composite COG with exactextract (exact fractional pixel coverage, C++).
Mean/sum/count are coverage-weighted; pixels that are NaN (masked) are excluded."""
from __future__ import annotations

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from exactextract import exact_extract
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from .errors import BadRequest, TooLarge
from . import config

OPS = {"mean", "median", "min", "max", "sum", "count", "stdev", "variance", "valid_pct"}
ALIAS = {"std": "stdev", "stddev": "stdev", "var": "variance"}


def zonal(path, band_names: list[str], fc: dict, stats: list[str]) -> list[dict]:
    if fc.get("type") != "FeatureCollection" or not isinstance(fc.get("features"), list):
        raise BadRequest("features must be a GeoJSON FeatureCollection")
    feats = fc["features"]
    if not feats:
        raise BadRequest("features is empty")
    if len(feats) > config.MAX_FEATURES:
        raise TooLarge(f"{len(feats)} features exceeds the limit of {config.MAX_FEATURES}; split the request")
    want = list(dict.fromkeys(ALIAS.get(s, s) for s in stats))
    bad = [s for s in want if s not in OPS]
    if bad:
        raise BadRequest(f"unsupported stats {bad}; supported: {sorted(OPS)}")
    ops = [s for s in want if s != "valid_pct"]
    if "valid_pct" in want and "count" not in ops:
        ops.append("count")

    with rasterio.open(path) as src:
        crs = src.crs
        to_r = Transformer.from_crs(4326, crs, always_xy=True).transform
        geoms = []
        for i, f in enumerate(feats):
            g = f.get("geometry") if isinstance(f, dict) else None
            if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
                raise BadRequest(f"feature {i}: geometry must be Polygon or MultiPolygon")
            geoms.append(shp_transform(to_r, shape(g)))
        # Per-feature coverage denominator = same call on an all-ones raster over the same grid.
        # (exactextract's "count" only counts non-NaN cells, so valid_pct = count / total coverage.)
        tf = [{"type": "Feature", "properties": {}, "geometry": g.__geo_interface__} for g in geoms]
        total = None
        if "valid_pct" in want:
            with MemoryFile() as mem:
                with mem.open(driver="GTiff", width=src.width, height=src.height, count=1, dtype="uint8",
                              crs=crs, transform=src.transform) as ones:
                    ones.write(np.ones((1, src.height, src.width), dtype="uint8"))
                with mem.open() as ones:
                    total = [r["properties"]["count"] for r in exact_extract(ones, tf, ["count"], include_cols=[], output="geojson")]
        res = exact_extract(src, tf, ops, include_cols=[], output="geojson")
    out = []
    for i, f in enumerate(feats):
        props = res[i]["properties"] if isinstance(res, list) else res["features"][i]["properties"]
        per_band: dict[str, dict] = {}
        for bi, name in enumerate(band_names, 1):
            row: dict = {}
            for op in want:
                if op == "valid_pct":
                    cnt = props.get(f"band_{bi}_count", props.get("count"))
                    t = total[i]
                    row[op] = round(100.0 * float(cnt) / t, 2) if t and cnt is not None else None
                else:
                    v = props.get(f"band_{bi}_{op}", props.get(op))
                    row[op] = None if v is None or (isinstance(v, float) and not np.isfinite(v)) else float(v)
            per_band[name] = row
        out.append({"index": i, "id": f.get("id"), "properties": f.get("properties") or {}, "stats": per_band})
    return out
