"""Fetch the monthly NDVI series (masked spatial median per month, Sentinel-2 L2A) for the backtest AOIs and store
them as JSON under eval/series/ so the backtest is reproducible offline.   uv run python eval/fetch_series.py [aoi...]"""
import json
import sys
import time
from pathlib import Path

from shapely.geometry import box

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, forecast  # noqa: E402

config.configure_gdal()
AOIS = {  # ~9-10 km2 each; first five are scripts/perf/baseline.mts AOIs
    "kasur": ([74.05, 31.12, 74.08, 31.15], "Kasur, PK: irrigated Punjab cropland"),
    "lahore": ([74.20, 31.28, 74.23, 31.31], "Lahore edge, PK: peri-urban"),
    "beauce": ([1.80, 48.30, 1.83, 48.33], "Beauce, FR: temperate large-field arable"),
    "iowa": ([-93.70, 42.00, -93.67, 42.03], "Story Co., Iowa, US: row crops"),
    "kitale": ([34.98, 1.00, 35.01, 1.03], "Kitale, KE: equatorial highland maize"),
    "landes": ([-0.95, 44.20, -0.92, 44.23], "Landes forest, FR: maritime pine plantation"),
}
FIRST, LAST = "2017-01", "2025-12"
RES = 20.0
out = Path(__file__).parent / "series"
for k in (sys.argv[1:] or AOIS):
    bbox, why = AOIS[k]
    t = time.time()
    f = forecast.fetch_monthly(box(*bbox), "NDVI", FIRST, LAST, RES, [4, 5, 6, 7, 11])
    months = {m: {"median": r.value, "valid_pct": r.valid_pct, "n_scenes": r.n_scenes} for m, r in sorted(f.months.items())}
    (out / f"{k}.json").write_text(json.dumps({"id": k, "why": why, "bbox": bbox, "expression": "NDVI", "resolution_m": RES,
                                                "first": FIRST, "last": LAST, "item_count": len(f.item_ids), "skipped_jp2_items": f.skipped_items, "months": months}, indent=0))
    print(k, f"{time.time() - t:.0f}s", len(months), "months with scenes,", len(f.item_ids), "items", flush=True)
