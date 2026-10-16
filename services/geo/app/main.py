from __future__ import annotations

import hashlib
import threading
import time
from datetime import datetime, timezone

import numpy as np
from fastapi import FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from rio_tiler.colormap import cmap
from rio_tiler.errors import TileOutsideBounds
from rio_tiler.io import Reader

from . import config, engine, store, zonal as zonal_mod
from .errors import GeoError, NotFound
from . import forecast as fc
from .models import DEFAULT_SCL_KEEP, AnomalyRequest, CompositeRequest, ForecastRequest, TimeseriesRequest, ZonalRequest

app = FastAPI(title="GeoAgent geo service", version="0.1.0")
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


@app.exception_handler(GeoError)
async def _geo_error(_: Request, e: GeoError):
    return JSONResponse({"error": e.code, "detail": e.detail}, status_code=e.status)


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, e: RequestValidationError):
    msgs = "; ".join((f"{'.'.join(str(p) for p in x['loc'][1:])}: " if len(x['loc']) > 1 else "")
                     + x['msg'].removeprefix("Value error, ") for x in e.errors())
    return JSONResponse({"error": "bad_request", "detail": msgs}, status_code=422)


@app.get("/health")
def health():
    return {"status": "ok", "cache_dir": str(config.CACHE_DIR), "stac": config.STAC_URL}


def _geom(req):
    return engine.aoi_geometry(req.bbox, req.geometry)


def _base(request: Request) -> str:
    return config.PUBLIC_URL or str(request.base_url).rstrip("/")


def _tile_url(request: Request, cid: str) -> str:
    return f"{_base(request)}/composite/{cid}/tiles/{{z}}/{{x}}/{{y}}.png"


# ---------- composite ----------
def run_composite(req: CompositeRequest, items) -> dict:
    """Compute (or fetch from cache) a composite for already-searched items. Separated from the route so
    tests can inject fixture items without network."""
    plan = engine.make_plan(req.bands, req.expression)
    geom = _geom(req)
    ids = [i.id for i in items]
    canon = store.canonical_request(req, plan)
    cid = store.composite_id(canon, ids)
    with _lock(cid):
        meta = store.read_meta(cid)
        if meta and store.cog_path(cid).exists():
            return {**meta, "cached": True}
        stack = engine.load_stack(items, geom, plan, req.resolution, req.scl_keep)
        data, nobs = engine.median_composite(stack, plan)
        aoi_n = int(stack.aoi.sum())
        valid = np.isfinite(data[0]) & stack.aoi
        valid_pct = round(100.0 * int(valid.sum()) / aoi_n, 2) if aoi_n else 0.0
        if not valid.any():
            return {
                "id": None, "items": ids, "item_count": len(ids), "valid_pixel_pct": 0.0,
                "message": f"{len(ids)} scene(s) found but every pixel in the AOI was masked (cloud/shadow/no-data); "
                           "no composite produced. Try a longer date range.",
                "cached": False,
            }
        data = np.where(stack.aoi[None], data, np.nan).astype(np.float32)
        h, w = data.shape[1:]
        from rasterio.transform import array_bounds
        from pyproj import Transformer
        l, b, r, t = array_bounds(h, w, stack.transform)
        tr = Transformer.from_crs(stack.crs, 4326, always_xy=True)
        (w84, s84), (e84, n84) = tr.transform(l, b), tr.transform(r, t)
        created = datetime.now(timezone.utc).isoformat(timespec="seconds")
        meta = {
            "id": cid, "items": ids, "item_count": len(ids), "scene_days": len(stack.days),
            "bands": plan.outputs, "expression": plan.expr.source if plan.expr else None,
            "valid_pixel_pct": valid_pct,
            "valid_obs_per_pixel": {"mean": round(float(nobs[stack.aoi].mean()), 2), "min": int(nobs[stack.aoi].min()),
                                    "max": int(nobs[stack.aoi].max())},
            "stats": {n: engine.band_stats(data[i], stack.aoi) for i, n in enumerate(plan.outputs)},
            "bounds": [w84, s84, e84, n84], "crs": stack.crs, "shape": [h, w], "resolution": req.resolution,
            "scl_keep": sorted(set(req.scl_keep)), "start": req.start.isoformat(), "end": req.end.isoformat(),
            "collection": req.collection, "request": canon, "created": created, "message": None,
        }
        store.write_cog(cid, data, plan.outputs, stack.transform, stack.crs, {"geo_id": cid, "created": created})
        store.write_meta(cid, meta)
        return {**meta, "cached": False}


def _empty(req, what: str) -> dict:
    return {"item_count": 0, "items": [], "message":
            f"No {req.collection} scenes intersect the AOI between {req.start} and {req.end}"
            + (f" with eo:cloud_cover < {req.max_cloud}%" if req.max_cloud is not None else "")
            + f"; no {what} produced."}


@app.post("/composite")
def composite(req: CompositeRequest, request: Request):
    engine.make_plan(req.bands, req.expression)  # validate before hitting the network
    items = engine.search_items(req)
    if not items:
        return {"id": None, "valid_pixel_pct": None, "cached": False, **_empty(req, "composite")}
    out = run_composite(req, items)
    if out.get("id"):
        out["tile_url_template"] = _tile_url(request, out["id"])
        out["download_url"] = f"{_base(request)}/composite/{out['id']}.tif"
    return out


# ---------- tiles / download ----------
def _need(cid: str) -> dict:
    meta = store.read_meta(cid)
    if not meta or not store.cog_path(cid).exists():
        raise NotFound(f"composite '{cid}' not found (not computed, or evicted from cache)")
    return meta


@app.get("/composite/{cid}.tif")
def download(cid: str):
    _need(cid)
    return FileResponse(store.cog_path(cid), media_type="image/tiff", filename=f"{cid}.tif")


@app.get("/composite/{cid}")
def info(cid: str, request: Request):
    meta = _need(cid)
    return {**meta, "tile_url_template": _tile_url(request, cid)}


@app.get("/composite/{cid}/tiles/{z}/{x}/{y}.png")
def tile(cid: str, z: int, x: int, y: int, rescale: str | None = None, colormap_name: str | None = None,
         bidx: list[int] | None = Query(None)):
    meta = _need(cid)
    names: list[str] = meta["bands"]
    idx = bidx or ([1, 2, 3] if len(names) == 3 else [1])
    if any(i < 1 or i > len(names) for i in idx) or len(idx) not in (1, 3):
        raise engine.BadRequest(f"bidx must be 1 or 3 band indexes within 1..{len(names)}")
    if rescale:
        try:
            lo, hi = (float(v) for v in rescale.split(","))
        except ValueError:
            raise engine.BadRequest("rescale must be 'min,max'") from None
        ranges = [(lo, hi)] * len(idx)
    elif len(idx) == 1:
        s = meta["stats"][names[idx[0] - 1]]
        ranges = [(s["p2"], s["p98"])]  # p2..p98 of the composite itself
    else:
        ranges = [(0.0, 0.3)] * 3  # reflectance, same stretch as titiler.ts RGB (0..3000 DN)
    cm = None
    if colormap_name and len(idx) == 1:
        try:
            cm = cmap.get(colormap_name)
        except Exception:
            raise engine.BadRequest(f"unknown colormap_name '{colormap_name}'") from None
    try:
        with Reader(str(store.cog_path(cid))) as src:
            img = src.tile(x, y, z, indexes=idx, tilesize=256)
    except TileOutsideBounds:
        return Response(status_code=204)
    img.rescale(ranges)
    if cm is not None:
        img = img.apply_colormap(cm)  # rio-tiler >= 6 returns a new ImageData
    return Response(img.render(img_format="PNG"), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600"})


# ---------- timeseries ----------
@app.post("/timeseries")
def timeseries(req: TimeseriesRequest):
    plan = engine.make_plan([req.band] if req.band else None, req.expression)
    items = engine.search_items(req)
    if not items:
        return {"series": [], "interval": req.interval, **_empty(req, "time series")}
    stack = engine.load_stack(items, _geom(req), plan, req.resolution, req.scl_keep)
    rows = engine.timeseries(stack, plan, req.interval)
    return {"series": rows, "interval": req.interval, "item_count": len(items), "items": [i.id for i in items],
            "band": plan.outputs[0], "expression": plan.expr.source if plan.expr else None,
            "resolution": req.resolution, "scl_keep": sorted(set(req.scl_keep)),
            "message": None if any(r["n_valid"] for r in rows) else
            "Scenes found but every AOI pixel was masked in all of them; values are null."}


# ---------- zonal ----------
@app.post("/zonal")
def zonal(req: ZonalRequest):
    meta = _need(req.source)
    res = zonal_mod.zonal(store.cog_path(req.source), meta["bands"], req.features, req.stats)
    return {"source": req.source, "bands": meta["bands"], "feature_count": len(res), "results": res,
            "note": "mean/sum/count are coverage-weighted (exactextract); masked (NaN) pixels excluded"}


# ---------- forecast / anomaly ----------
def _current_month() -> str:
    d = datetime.now(timezone.utc)
    return f"{d.year:04d}-{d.month:02d}"


def _fetch(req, first: str, last: str):
    t0 = time.perf_counter()
    plan = engine.make_plan(None, req.expression)  # validate before hitting the network
    f = fc.fetch_monthly(_geom(req), req.expression, first, last, req.resolution, list(DEFAULT_SCL_KEEP))
    return plan, f, round(time.perf_counter() - t0, 2)


def _provenance(f) -> dict:
    ids = sorted(f.item_ids)
    return {"item_count": len(ids), "items_digest": hashlib.sha256("\n".join(ids).encode()).hexdigest()[:16],
            "first_item": ids[0] if ids else None, "last_item": ids[-1] if ids else None,
            "skipped_unreadable_items": f.skipped_items}


def _model_block(method: str) -> dict:
    return {**fc.method_info(method), "backtest": fc.backtest_reference(method)}


def _timing(method: str, fetch_s: float, t0: float) -> dict:
    return {"fetch_s": fetch_s, "total_s": round(time.perf_counter() - t0, 2),
            **({"model_load_s": fc.TimesFM.load_s, "inference_s": fc.TimesFM.last_infer_s} if method == "timesfm" else {})}


@app.post("/forecast")
def forecast(req: ForecastRequest):
    t0 = time.perf_counter()
    method = fc.resolve_method(req.method, default="timesfm")  # whole endpoint is behind GEO_TIMESFM=1
    first, last = fc.parse_month(req.history_start.isoformat()), fc.parse_month(req.history_end.isoformat())
    if fc.month_diff(last, _current_month()) < 1:
        raise engine.BadRequest(f"history_end {last} is not a complete month yet; use {fc.month_add(_current_month(), -1)} or earlier")
    plan, f, fetch_s = _fetch(req, first, last)
    h = fc.prepare_history(f.months, first, last)
    targets = [fc.month_add(last, i) for i in range(1, req.horizon_months + 1)]
    rows = fc.run_method(method, h, targets)
    return {
        "expression": f.expression, "band": f.band, "interval": "month", "resolution": req.resolution,
        "history": h.rows(),
        "forecast": [{"month": r["month"], **{k: round(r[k], 4) for k in ("p10", "p50", "p90")}} for r in rows],
        "kind": "forecast",
        "note": "Forecast, not observation: p10-p90 is the expected 80% range, not a guarantee.",
        "model": _model_block(method),
        "imputed_months": [m for m, i in zip(h.months, h.imputed) if i],
        "unfilled_gap_months": h.unfilled_gap_months, "history_trimmed_from": h.trimmed_from,
        "warnings": h.warnings, "provenance": _provenance(f), "timing": _timing(method, fetch_s, t0),
        "backtest": fc.backtest_reference(method),
    }


@app.post("/anomaly")
def anomaly(req: AnomalyRequest):
    t0 = time.perf_counter()
    method = fc.resolve_method(req.method)
    target = fc.parse_month(req.target_month + "-01" if len(req.target_month) == 7 else req.target_month)
    cur = _current_month()
    if fc.month_diff(target, cur) < 0:
        raise engine.BadRequest(f"target_month {target} is in the future: there is no observation to compare")
    first, last = fc.month_add(target, -12 * req.history_years), fc.month_add(target, -1)
    plan, f, fetch_s = _fetch(req, first, fc.month_add(target, 0))
    base = {"expression": f.expression, "band": f.band, "target_month": target, "kind": "anomaly",
            "history_years": req.history_years, "model": _model_block(method), "provenance": _provenance(f),
            "backtest": fc.backtest_reference(method)}
    raw = f.months.get(target)
    obs = raw.value if raw and raw.value is not None and raw.valid_pct >= fc.MIN_VALID_PCT else None
    warnings = []
    if target == cur:
        warnings.append(f"{target} is the current month: the observation rests only on scenes acquired so far")
    reason = None
    try:
        h = fc.prepare_history(f.months, first, last)
        exp = fc.run_method(method, h, [target])[0]
    except fc.InsufficientHistory as e:
        return {**base, "observed": obs, "observed_valid_pct": raw.valid_pct if raw else 0.0, "expected_p10": None,
                "expected_p50": None, "expected_p90": None, "score": None, "verdict": "cannot_determine",
                "reason": f"history too short or sparse to say what was expected: {e.detail}", "warnings": warnings,
                "history": [], "imputed_months": [], "timing": _timing(method, fetch_s, t0)}
    verdict, score = fc.anomaly_verdict(obs, exp["p10"], exp["p50"], exp["p90"])
    if obs is None:
        reason = (f"no clear observation of {target} covering at least {fc.MIN_VALID_PCT:.0f}% of the AOI"
                  + (f" (best month coverage {raw.valid_pct}%)" if raw else " (no Sentinel-2 scene)")
                  + "; the expected range is shown but there is nothing to compare it with")
    return {**base, "observed": None if obs is None else round(obs, 4), "observed_valid_pct": raw.valid_pct if raw else 0.0,
            "observed_n_scenes": raw.n_scenes if raw else 0,
            "expected_p10": round(exp["p10"], 4), "expected_p50": round(exp["p50"], 4), "expected_p90": round(exp["p90"], 4),
            "score": score, "verdict": verdict, "reason": reason, "warnings": warnings + h.warnings,
            "history": h.rows(), "imputed_months": [m for m, i in zip(h.months, h.imputed) if i],
            "timing": _timing(method, fetch_s, t0)}
