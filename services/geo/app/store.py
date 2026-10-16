"""Content-addressed COG cache: id = sha256(canonical request + sorted STAC item ids)."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

import numpy as np
import rasterio
import rasterio.shutil
from affine import Affine

from . import config

HASH_VERSION = "composite-v1"  # bump when masking/median semantics change so old COGs are not reused


def _round(o, nd=6):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [_round(x, nd) for x in o]
    if isinstance(o, dict):
        return {k: _round(v, nd) for k, v in o.items()}
    return o


def canonical_request(req, plan) -> dict:
    return {
        "v": HASH_VERSION,
        "collection": req.collection,
        "aoi": _round(req.bbox) if req.bbox is not None else _round(req.geometry),
        "start": req.start.isoformat(), "end": req.end.isoformat(),
        "bands": plan.needed if plan.expr is None else None,
        "expression": plan.expr.source if plan.expr is not None else None,
        "max_cloud": req.max_cloud, "resolution": req.resolution,
        "scl_keep": sorted(set(req.scl_keep)),
    }


def composite_id(canon: dict, item_ids: list[str]) -> str:
    payload = json.dumps({"req": canon, "items": sorted(item_ids)}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


def cog_path(cid: str) -> Path:
    return config.CACHE_DIR / f"{cid}.tif"


def meta_path(cid: str) -> Path:
    return config.CACHE_DIR / f"{cid}.json"


def read_meta(cid: str) -> dict | None:
    if not cid.isalnum():
        return None
    try:
        return json.loads(meta_path(cid).read_text())
    except (OSError, ValueError):
        return None


def _atomic(path: Path, write):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=path.suffix + ".tmp")
    os.close(fd)
    try:
        write(tmp)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_cog(cid: str, data: np.ndarray, names: list[str], transform: Affine, crs: str, tags: dict) -> None:
    def _w(tmp: str):
        with tempfile.NamedTemporaryFile(suffix=".tif", dir=config.CACHE_DIR) as scratch:
            with rasterio.open(scratch.name, "w", driver="GTiff", width=data.shape[2], height=data.shape[1],
                               count=data.shape[0], dtype="float32", crs=crs, transform=transform, nodata=np.nan) as dst:
                dst.write(data)
                for i, n in enumerate(names, 1):
                    dst.set_band_description(i, n)
                dst.update_tags(**{k: str(v) for k, v in tags.items()})
            rasterio.shutil.copy(scratch.name, tmp, driver="COG", compress="DEFLATE", predictor=3,
                                 blocksize=512, overview_resampling="average")
    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _atomic(cog_path(cid), _w)


def write_meta(cid: str, meta: dict) -> None:
    _atomic(meta_path(cid), lambda tmp: Path(tmp).write_text(json.dumps(meta)))
