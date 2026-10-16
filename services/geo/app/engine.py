"""Search, load, cloud-mask and reduce Sentinel-2 L2A from Earth Search.

Matches the TypeScript side (src/app/api/agent/lib/{stac,cloud,reflectance}.ts):
  * collection `sentinel-2-l2a`, lowercase Earth Search asset keys (red, nir, swir16 ... and `scl`);
  * reflectance = DN * 0.0001 with NO additive offset: Earth Search declares offset -0.1 in raster:bands
    but serves pixels that already have the baseline-04.00 BOA offset removed (see reflectance.ts);
  * clear SCL classes = cloud.ts CLEAR_CLASSES = {4 vegetation, 5 bare, 6 water, 7 unclassified, 11 snow}.
    Dropped: 0 no-data, 1 saturated, 2 dark area (ambiguous: terrain shadow vs dark surface; same as the TS
    side), 3 cloud shadow, 8/9 cloud, 10 thin cirrus. Override per request with `scl_keep`."""
from __future__ import annotations

import warnings
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import numpy as np
import odc.stac
import pystac
import rasterio.features
import rasterio.errors
from affine import Affine
from pyproj import Transformer
from pystac_client import Client
from shapely.geometry import box, shape
from shapely.ops import transform as shp_transform

from . import config
from .errors import BadRequest, FetchFailed, TooLarge
from .expr import Compiled, canonical_band, compile_expression

S2_SCALE = 0.0001


# ---------- AOI ----------
def aoi_geometry(bbox, geometry):
    if bbox is not None:
        return box(*bbox)
    g = geometry
    if g.get("type") == "Feature":
        g = g.get("geometry")
    if g.get("type") == "FeatureCollection":
        raise BadRequest("geometry must be a Polygon/MultiPolygon, not a FeatureCollection")
    if not g or g.get("type") not in ("Polygon", "MultiPolygon"):
        raise BadRequest("geometry must be a GeoJSON Polygon or MultiPolygon")
    geom = shape(g)
    if geom.is_empty or not geom.is_valid:
        raise BadRequest("geometry is empty or invalid")
    return geom


def utm_epsg(geom) -> int:
    c = geom.centroid
    zone = int((c.x + 180) // 6) + 1
    return (32600 if c.y >= 0 else 32700) + min(max(zone, 1), 60)


# ---------- plan ----------
@dataclass
class Plan:
    needed: list[str]            # source bands to load
    outputs: list[str]           # output band names
    expr: Compiled | None

    def apply(self, env: dict[str, np.ndarray]) -> list[np.ndarray]:
        if self.expr is not None:
            return [self.expr(env)]
        return [env[b] for b in self.needed]


def make_plan(bands: list[str] | None, expression: str | None) -> Plan:
    if expression:
        c = compile_expression(expression)
        return Plan(needed=c.bands, outputs=[c.name], expr=c)
    bs = list(dict.fromkeys(canonical_band(b) for b in bands or []))
    return Plan(needed=bs, outputs=bs, expr=None)


# ---------- search ----------
@lru_cache(maxsize=1)
def _client() -> Client:
    return Client.open(config.STAC_URL, timeout=30)


def search_items(req) -> list[pystac.Item]:
    """Earth Search lookup. Raises FetchFailed on any transport/API error; [] means genuinely no scenes."""
    kwargs: dict = {
        "collections": [req.collection],
        "datetime": f"{req.start.isoformat()}T00:00:00Z/{req.end.isoformat()}T23:59:59Z",
        "max_items": config.MAX_ITEMS,
    }
    if req.bbox is not None:
        kwargs["bbox"] = req.bbox
    else:
        kwargs["intersects"] = aoi_geometry(None, req.geometry).__geo_interface__
    if req.max_cloud is not None:
        kwargs["query"] = {"eo:cloud_cover": {"lt": req.max_cloud}}
    try:
        items = list(_client().search(**kwargs).items())
    except Exception as e:  # pystac_client.APIError, requests/httpx errors, JSON errors
        _client.cache_clear()
        raise FetchFailed(f"STAC search failed: {type(e).__name__}: {e}") from e
    uniq = {i.id: i for i in items}
    return sorted(uniq.values(), key=lambda i: (i.datetime or datetime.min.replace(tzinfo=timezone.utc), i.id))


def solar_day(item: pystac.Item) -> str:
    dt = item.datetime or datetime.fromisoformat(item.properties["datetime"].replace("Z", "+00:00"))
    lon = (item.bbox[0] + item.bbox[2]) / 2 if item.bbox else 0.0
    return (dt + timedelta(hours=lon / 15.0)).date().isoformat()


# ---------- load + mask ----------
@dataclass
class Stack:
    days: list[str]                    # solar-day key per time slice
    day_items: list[list[str]]         # item ids merged into each slice
    refl: dict[str, np.ndarray]        # band -> (t,y,x) float32 reflectance, NaN where masked
    aoi: np.ndarray                    # (y,x) bool, pixels inside the AOI
    transform: Affine
    crs: str


def load_stack(items: list[pystac.Item], geom, plan: Plan, resolution: float, scl_keep: list[int]) -> Stack:
    epsg = utm_epsg(geom)
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True).transform
    geom_utm = shp_transform(to_utm, geom)
    minx, miny, maxx, maxy = geom_utm.bounds
    ny = int(np.ceil((maxy - miny) / resolution))
    nx = int(np.ceil((maxx - minx) / resolution))
    if nx * ny > config.MAX_PIXELS:
        raise TooLarge(f"AOI is {nx}x{ny} px at {resolution} m (limit {config.MAX_PIXELS}); use a larger resolution or a smaller AOI")
    for it in items:
        it.properties["geo_day"] = solar_day(it)
    groups: dict[str, list[str]] = {}
    for it in items:
        groups.setdefault(it.properties["geo_day"], []).append(it.id)
    days = sorted(groups)
    if nx * ny * len(days) * (len(plan.needed) + 1) > config.MAX_STACK_ELEMENTS:
        raise TooLarge(f"{len(days)} scene-days x {nx}x{ny} px x {len(plan.needed) + 1} bands exceeds the in-memory limit; "
                       "shorten the range, enlarge the resolution or shrink the AOI")
    bands = list(dict.fromkeys([*plan.needed, "scl"]))
    try:
        ds = odc.stac.load(
            items, bands=bands, crs=f"EPSG:{epsg}", resolution=resolution,
            x=(minx, maxx), y=(miny, maxy), groupby="geo_day", resampling="nearest",
            chunks={"x": 1024, "y": 1024}, fail_on_error=True,
        ).compute()
    except (rasterio.errors.RasterioError, OSError) as e:
        raise FetchFailed(f"COG read failed: {type(e).__name__}: {e}") from e
    except Exception as e:  # odc-stac wraps reader errors in several types; anything here is a read failure
        raise FetchFailed(f"raster load failed: {type(e).__name__}: {e}") from e
    if ds.sizes["time"] != len(days):
        raise FetchFailed(f"internal grouping mismatch: {ds.sizes['time']} slices vs {len(days)} days")
    affine = ds.odc.geobox.affine
    ny, nx = ds.sizes["y"], ds.sizes["x"]
    aoi = rasterio.features.geometry_mask([geom_utm], (ny, nx), affine, invert=True)
    if not aoi.any():  # AOI smaller than a pixel: include touched pixels rather than report nothing
        aoi = rasterio.features.geometry_mask([geom_utm], (ny, nx), affine, invert=True, all_touched=True)
    scl = ds["scl"].values
    ok = np.isin(scl, np.asarray(scl_keep, dtype=scl.dtype)) & aoi[None]
    for b in plan.needed:
        dn = ds[b].values
        ok &= np.isfinite(dn) & (dn != 0)  # DN 0 is the L2A no-data value (NaN if the loader promoted to float)
    refl = {b: np.where(ok, ds[b].values.astype(np.float32) * S2_SCALE, np.nan).astype(np.float32) for b in plan.needed}
    return Stack(days=days, day_items=[sorted(groups[d]) for d in days], refl=refl, aoi=aoi,
                 transform=affine, crs=f"EPSG:{epsg}")


# ---------- reductions ----------
def nan_median(a: np.ndarray, axis: int = 0) -> np.ndarray:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN slices -> NaN, which is the point
        return np.nanmedian(a, axis=axis).astype(np.float32)


def median_composite(stack: Stack, plan: Plan) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel median over time of each source band, THEN the expression (index of the median
    reflectance, as in GEE). Returns ((bands,y,x) float32 with NaN holes, per-pixel valid-observation count)."""
    med = {b: nan_median(stack.refl[b]) for b in plan.needed}
    outs = plan.apply(med)
    nobs = np.isfinite(stack.refl[plan.needed[0]]).sum(axis=0).astype(np.int16)
    return np.stack(outs).astype(np.float32), nobs


def band_stats(arr: np.ndarray, aoi: np.ndarray) -> dict:
    v = arr[aoi & np.isfinite(arr)]
    if v.size == 0:
        return {"min": None, "max": None, "mean": None, "p2": None, "p98": None, "n": 0}
    p2, p98 = np.percentile(v, [2, 98])
    return {"min": float(v.min()), "max": float(v.max()), "mean": float(v.mean()),
            "p2": float(p2), "p98": float(p98), "n": int(v.size)}


def spatial_stats(a: np.ndarray, aoi: np.ndarray) -> dict:
    """Unweighted pixel stats over the AOI for one 2D slice."""
    total = int(aoi.sum())
    v = a[aoi & np.isfinite(a)]
    return {
        "mean": float(v.mean()) if v.size else None,
        "median": float(np.median(v)) if v.size else None,
        "valid_pct": round(100.0 * v.size / total, 2) if total else 0.0,
        "n_valid": int(v.size),
    }


def timeseries(stack: Stack, plan: Plan, interval: str) -> list[dict]:
    rows: list[dict] = []
    if interval == "scene":
        for t, day in enumerate(stack.days):
            out = plan.apply({b: stack.refl[b][t] for b in plan.needed})[0]
            rows.append({"date": day, "item_ids": stack.day_items[t], **spatial_stats(out, stack.aoi)})
    else:
        months: dict[str, list[int]] = {}
        for t, day in enumerate(stack.days):
            months.setdefault(day[:7], []).append(t)
        for m in sorted(months):
            idx = months[m]
            med = {b: nan_median(stack.refl[b][idx]) for b in plan.needed}
            out = plan.apply(med)[0]
            rows.append({"date": m, "item_ids": sorted(i for t in idx for i in stack.day_items[t]),
                         "n_scenes": len(idx), **spatial_stats(out, stack.aoi)})
    return rows
