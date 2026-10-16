"""Rolling-origin backtest: TimesFM 2.5 vs seasonal-naive vs monthly climatology on monthly NDVI (Sentinel-2).

For every target month T in 2023-01..2025-12 and lead L in {1, 3}: the history ends at T-L (same refusal rules as
the service), each method forecasts T, and it is scored against the observed value of T (only months with a clear
observation over >= 30% of the AOI are scored). A sample is used only if ALL methods can forecast it.

    uv run python eval/backtest.py            # needs eval/series/*.json (eval/fetch_series.py)
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, forecast as fc  # noqa: E402

HERE = Path(__file__).parent
FIRST = "2017-01"
TARGETS = fc.month_range("2023-01", "2025-12")
LEADS = (1, 3)
METHODS = ("timesfm", "climatology", "seasonal_naive")
QS = (0.1, 0.5, 0.9)


def pinball(y, p10, p50, p90):
    return float(np.mean([max(q * (y - p), (q - 1) * (y - p)) for q, p in zip(QS, (p10, p50, p90))]))


def load(aoi: str):
    d = json.loads((HERE / "series" / f"{aoi}.json").read_text())
    raw = {m: fc.RawMonth(v["median"], v["valid_pct"], v.get("n_scenes", 0)) for m, v in d["months"].items()}
    return d, raw


def run_aoi(aoi: str):
    d, raw = load(aoi)
    rows, refused = [], 0
    jobs = []
    for lead in LEADS:
        for t in TARGETS:
            r = raw.get(t)
            if r is None or r.value is None or r.valid_pct < fc.MIN_VALID_PCT:
                continue  # nothing observed to score against
            o = fc.month_add(t, -lead)
            try:
                h = fc.prepare_history(raw, FIRST, o)
                clim = fc.climatology(h, [t])[0]
            except fc.InsufficientHistory:
                refused += 1
                continue
            i = h.months.index(fc.month_add(t, -12)) if fc.month_add(t, -12) in h.months else None
            if i is None or np.isnan(h.values[i]):
                refused += 1
                continue
            jobs.append((lead, t, r.value, h, clim, float(h.values[i])))
    # TimesFM, one series at a time (batch 1), timed
    t0 = time.perf_counter()
    for lead, t, y, h, clim, naive in jobs:
        tf = fc.timesfm_forecast(h, [t])[0]
        rows.append({"aoi": aoi, "lead": lead, "target": t, "y": y, "naive": naive,
                     "clim": [clim["p10"], clim["p50"], clim["p90"]], "tfm": [tf["p10"], tf["p50"], tf["p90"]]})
    return rows, refused, time.perf_counter() - t0, len(jobs)


def metrics(rows):
    y = np.array([r["y"] for r in rows])
    out = {"n": len(rows)}
    pred = {"timesfm": np.array([r["tfm"][1] for r in rows]), "climatology": np.array([r["clim"][1] for r in rows]),
            "seasonal_naive": np.array([r["naive"] for r in rows])}
    for k, p in pred.items():
        out[k] = {"mae": float(np.mean(np.abs(y - p))), "rmse": float(np.sqrt(np.mean((y - p) ** 2)))}
    for k, key in (("timesfm", "tfm"), ("climatology", "clim")):
        lo, hi = np.array([r[key][0] for r in rows]), np.array([r[key][2] for r in rows])
        out[k]["coverage"] = float(np.mean((y >= lo) & (y <= hi)))
        out[k]["pinball"] = float(np.mean([pinball(r["y"], *r[key]) for r in rows]))
        out[k]["width"] = float(np.mean(hi - lo))
    return out


def write_summary(res: dict) -> None:
    """The measured accuracy the service quotes in every /anomaly and /forecast response."""
    ref = "eval/RESULTS.md#timesfm-forecasting-backtest"
    out = {}
    for m, key in (("timesfm", "timesfm"), ("climatology", "climatology")):
        l3, l1 = res["per_lead"]["3"]["pooled"], res["per_lead"]["1"]["pooled"]
        out[m] = {"reference": ref, "coverage_p10_p90_pct": round(100 * l3[key]["coverage"], 1),
                  "coverage_p10_p90_pct_lead1": round(100 * l1[key]["coverage"], 1),
                  "mae_lead3": round(l3[key]["mae"], 4), "mae_lead1": round(l1[key]["mae"], 4),
                  "n": l3["n"], "aois": len(res["aois"])}
    (Path(config.__file__).parent / "backtest_summary.json").write_text(json.dumps({"methods": out}, indent=1))


def main():
    if "--summary-only" in sys.argv:
        write_summary(json.loads((HERE / "backtest_results.json").read_text()))
        return
    aois = sorted(p.stem for p in (HERE / "series").glob("*.json"))
    allrows, meta = [], {}
    for a in aois:
        rows, refused, secs, n = run_aoi(a)
        allrows += rows
        meta[a] = {"refused_or_unusable_origins": refused, "timesfm_s": round(secs, 1), "n_forecasts": n}
        print(a, n, "forecasts", f"{secs:.0f}s", "refused", refused, flush=True)
    res = {"aois": aois, "meta": meta, "model": fc.TimesFM.info(), "per_lead": {}}
    for lead in LEADS:
        sel = [r for r in allrows if r["lead"] == lead]
        res["per_lead"][str(lead)] = {"pooled": metrics(sel), "by_aoi": {a: metrics([r for r in sel if r["aoi"] == a]) for a in aois if any(r["aoi"] == a for r in sel)}}
    (HERE / "backtest_results.json").write_text(json.dumps({**res, "rows": allrows}))
    write_summary(res)
    print(json.dumps(res["per_lead"]["3"]["pooled"], indent=1))


if __name__ == "__main__":
    main()
