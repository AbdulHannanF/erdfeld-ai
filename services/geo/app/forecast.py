"""Monthly index series -> honest forecast / anomaly.

Honesty rules: a forecast is never an observation, every value comes with a p10-p90 range, and the
code REFUSES (422 `insufficient_history`) instead of guessing when the history is short or sparse.

  * The series is the per-month spatial median of the SCL-masked index (engine.timeseries, interval=month).
    A month counts as observed only if >= MIN_VALID_PCT of the AOI had a clear observation.
  * Gaps of <= MAX_FILL_GAP consecutive months inside the series are linearly interpolated and flagged
    `imputed`. Longer interior gaps stay missing (`value: null`); the model fills them internally (TimesFM
    linear-interpolates NaN) and the response says how many months that applies to.
  * Refusals: fewer than MIN_HISTORY_MONTHS months from the first observed month, more than MAX_MISSING_FRAC
    of those months without an observation, or no observation in the last MAX_TRAILING_GAP months.

Methods: `timesfm` (TimesFM 2.5, CPU) or `climatology` (mean of the same calendar month in earlier years with a
t-based prediction interval). Which one answers is `config.FORECAST_METHOD`, chosen from the backtest in
eval/RESULTS.md; the other stays reachable per request only when GEO_TIMESFM=1.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

from . import config, engine
from .errors import BadRequest, GeoError, TooLarge

MIN_HISTORY_MONTHS = 36
MAX_MISSING_FRAC = 0.25
MAX_FILL_GAP = 2
MAX_TRAILING_GAP = 2
MIN_VALID_PCT = 30.0  # % of AOI pixels with a clear observation for a month to count as observed
MAX_HORIZON = 12
Z90 = 1.2815515655446004  # standard-normal 90th percentile

# Student t, one-sided 0.90, df 1..20 (prediction interval of the climatology method)
_T90 = [3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372,
        1.363, 1.356, 1.350, 1.345, 1.341, 1.337, 1.333, 1.330, 1.328, 1.325]


class InsufficientHistory(GeoError):
    """The history is too short or too sparse to forecast honestly. A refusal, not a failure."""
    status = 422
    code = "insufficient_history"


# ---------- months ----------
def month_add(m: str, k: int) -> str:
    y, mo = int(m[:4]), int(m[5:7])
    i = y * 12 + (mo - 1) + k
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def month_diff(a: str, b: str) -> int:
    """Months from a to b."""
    return (int(b[:4]) * 12 + int(b[5:7])) - (int(a[:4]) * 12 + int(a[5:7]))


def month_range(a: str, b: str) -> list[str]:
    return [month_add(a, i) for i in range(month_diff(a, b) + 1)]


def parse_month(s: str) -> str:
    try:
        d = date.fromisoformat(s[:7] + "-01")
    except ValueError:
        raise BadRequest(f"'{s}' is not a YYYY-MM or YYYY-MM-DD date") from None
    return f"{d.year:04d}-{d.month:02d}"


# ---------- fetching ----------
@dataclass
class RawMonth:
    value: float | None
    valid_pct: float
    n_scenes: int = 0


@dataclass
class Fetched:
    months: dict[str, RawMonth]
    item_ids: set[str]
    expression: str | None
    band: str
    skipped_items: int = 0  # scenes only available as requester-pays JP2 (unreadable here); their months may be gaps


def _quarter_key(geom, plan, resolution, scl_keep, first, last, ids) -> str:
    # Like composites: the key includes the STAC item set, so a scene landing late can never serve a stale quarter.
    canon = {"v": "series-v1", "geom": [round(c, 6) for c in geom.bounds], "area": round(geom.area, 9),
             "expr": plan.expr.source if plan.expr else plan.outputs, "res": resolution, "scl": sorted(set(scl_keep)),
             "q": [first, last], "items": sorted(ids)}
    return hashlib.sha256(json.dumps(canon, sort_keys=True).encode()).hexdigest()[:24]


def _cache_path(key: str):
    return config.CACHE_DIR.parent / "series" / f"{key}.json"


def _cache_read(key: str):
    try:
        return json.loads(_cache_path(key).read_text())
    except (OSError, ValueError):
        return None


def _cache_write(key: str, rows: list[dict]) -> None:
    try:
        p = _cache_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.with_suffix(".tmp").write_text(json.dumps(rows))
        p.with_suffix(".tmp").replace(p)
    except OSError:
        pass  # a cache that cannot be written only costs time


def fetch_monthly(geom, expression: str, first: str, last: str, resolution: float, scl_keep: list[int]) -> Fetched:
    """Monthly masked-median series for months first..last (inclusive), read quarter by quarter so memory stays
    bounded and the STAC item cap can never truncate silently."""
    from .models import TimeseriesRequest

    plan = engine.make_plan(None, expression)
    out: dict[str, RawMonth] = {}
    ids: set[str] = set()
    skipped = 0
    cur = first
    while month_diff(cur, last) >= 0:
        q_end = month_add(cur, 2 - ((int(cur[5:7]) - 1) % 3))  # last month of this calendar quarter
        if month_diff(q_end, last) < 0:
            q_end = last
        start = date.fromisoformat(cur + "-01")
        end_next = month_add(q_end, 1)
        end = date.fromisoformat(end_next + "-01") - timedelta(days=1)
        req = TimeseriesRequest(geometry=geom.__geo_interface__, start=start, end=end, expression=expression,
                                interval="month", resolution=resolution, scl_keep=scl_keep)
        items = engine.search_items(req)
        if len(items) >= config.MAX_ITEMS:
            raise TooLarge(f"{len(items)} scenes in one quarter reaches the per-search cap ({config.MAX_ITEMS}); "
                           "use a smaller AOI")
        # Some 2017-18 scenes only exist as JP2 on a requester-pays bucket: unreadable, so skipped (and counted).
        readable = [i for i in items if all(str(i.assets[b].href).endswith((".tif", ".tiff")) for b in [*plan.needed, "scl"]
                                            if b in i.assets)]
        skipped += len(items) - len(readable)
        items = readable
        if items:
            key = _quarter_key(geom, plan, resolution, scl_keep, cur, q_end, [i.id for i in items])
            rows = _cache_read(key)
            if rows is None:
                stack = engine.load_stack(items, geom, plan, resolution, scl_keep)
                rows = [{k: r[k] for k in ("date", "median", "valid_pct", "n_scenes")} for r in engine.timeseries(stack, plan, "month")]
                _cache_write(key, rows)
            for r in rows:
                out[r["date"]] = RawMonth(r["median"], r["valid_pct"], r.get("n_scenes", 0))
            ids.update(i.id for i in items)
        cur = month_add(q_end, 1)
    return Fetched(out, ids, plan.expr.source if plan.expr else None, plan.outputs[0], skipped)


# ---------- history preparation ----------
@dataclass
class History:
    months: list[str]
    values: np.ndarray                 # NaN = missing (not imputed); imputed months hold the interpolated value
    observed: np.ndarray               # bool: a real clear observation
    imputed: np.ndarray                # bool: filled by linear interpolation (gap <= MAX_FILL_GAP)
    valid_pct: list[float]
    trimmed_from: str | None = None    # leading months without any observation that were dropped
    unfilled_gap_months: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def last(self) -> str:
        return self.months[-1]

    def rows(self) -> list[dict]:
        return [{"month": m, "value": None if np.isnan(v) else round(float(v), 5), "valid_pct": vp,
                 "imputed": bool(i)} for m, v, vp, i in zip(self.months, self.values, self.valid_pct, self.imputed)]


def prepare_history(raw: dict[str, RawMonth], first: str, last: str, *, min_months: int = MIN_HISTORY_MONTHS) -> History:
    months = month_range(first, last)
    vals = np.full(len(months), np.nan)
    vpct = [0.0] * len(months)
    for i, m in enumerate(months):
        r = raw.get(m)
        if r is None:
            continue
        vpct[i] = r.valid_pct
        if r.value is not None and r.valid_pct >= MIN_VALID_PCT:
            vals[i] = r.value
    obs = ~np.isnan(vals)
    if not obs.any():
        raise InsufficientHistory(f"no month between {first} and {last} has a clear observation over at least "
                                  f"{MIN_VALID_PCT:.0f}% of the AOI; nothing to forecast from")
    lead = int(np.argmax(obs))
    trimmed = months[0] if lead else None
    months, vals, obs, vpct = months[lead:], vals[lead:], obs[lead:], vpct[lead:]
    n = len(months)
    if n < min_months:
        raise InsufficientHistory(f"only {n} months of history from the first observed month ({months[0]}); "
                                  f"at least {min_months} are required for a seasonal forecast")
    missing = int((~obs).sum())
    if missing / n > MAX_MISSING_FRAC:
        raise InsufficientHistory(f"{missing} of {n} months ({100 * missing / n:.0f}%) have no clear observation "
                                  f"(limit {100 * MAX_MISSING_FRAC:.0f}%); the series is too sparse to forecast honestly")
    last_obs = int(np.flatnonzero(obs)[-1])
    trailing = n - 1 - last_obs
    if trailing > MAX_TRAILING_GAP:
        raise InsufficientHistory(f"the last clear observation is {trailing} months before {months[-1]} "
                                  f"(limit {MAX_TRAILING_GAP}); the history is stale")
    imputed = np.zeros(n, dtype=bool)
    i = 0
    unfilled = 0
    while i <= last_obs:
        if obs[i]:
            i += 1
            continue
        j = i
        while not obs[j]:
            j += 1
        if j - i <= MAX_FILL_GAP:
            vals[i:j] = np.interp(np.arange(i, j), [i - 1, j], [vals[i - 1], vals[j]])
            imputed[i:j] = True
        else:
            unfilled += j - i
        i = j
    h = History(months, vals, obs, imputed, vpct, trimmed, unfilled)
    if trimmed:
        h.warnings.append(f"history starts at {months[0]}: earlier months had no clear observation")
    if unfilled:
        h.warnings.append(f"{unfilled} month(s) in gaps longer than {MAX_FILL_GAP} months were not filled; "
                          "the model interpolates across them")
    if trailing:
        h.warnings.append(f"the last {trailing} month(s) of history have no clear observation; "
                          "the forecast starts from the last observed month")
    return h


# ---------- methods ----------
def climatology(h: History, targets: list[str]) -> list[dict]:
    """Mean of the same calendar month over earlier years (real observations only) with a t prediction interval."""
    out = []
    for t in targets:
        prior = [v for m, v, o in zip(h.months, h.values, h.observed) if o and m[5:7] == t[5:7] and m < t]
        n = len(prior)
        if n < 3:
            raise InsufficientHistory(f"only {n} earlier observation(s) of calendar month {t[5:7]}; at least 3 are "
                                      "needed for a climatology range")
        mu, sd = float(np.mean(prior)), float(np.std(prior, ddof=1))
        k = (_T90[n - 2] if n - 1 <= len(_T90) else Z90) * sd * math.sqrt(1 + 1 / n)
        out.append({"month": t, "p10": mu - k, "p50": mu, "p90": mu + k})
    return out


class TimesFM:
    """Lazy singleton around TimesFM 2.5 (200M, Apache-2.0) on CPU. Records load and inference time."""

    _lock = threading.Lock()
    _model = None
    load_s: float | None = None
    last_infer_s: float | None = None
    revision: str | None = None

    @classmethod
    def _load(cls):
        if cls._model is not None:
            return cls._model
        import timesfm  # heavy import (torch): only when a TimesFM request arrives
        from huggingface_hub import snapshot_download

        t0 = time.perf_counter()
        # Pin the commit: provenance must name the exact weights that produced a number.
        path = snapshot_download(config.TIMESFM_MODEL_ID, revision=config.TIMESFM_REVISION)
        m = timesfm.TimesFM_2p5_200M_torch.from_pretrained(path, torch_compile=False)
        m.compile(timesfm.ForecastConfig(
            max_context=512, max_horizon=128, normalize_inputs=True, use_continuous_quantile_head=True,
            force_flip_invariance=True, infer_is_positive=False, fix_quantile_crossing=True))
        cls.load_s = round(time.perf_counter() - t0, 2)
        cls.revision = config.TIMESFM_REVISION
        cls._model = m
        return m

    @classmethod
    def info(cls) -> dict:
        return {"id": config.TIMESFM_MODEL_ID, "revision": config.TIMESFM_REVISION, "method": "timesfm",
                "license": "Apache-2.0", "load_s": cls.load_s, "infer_s": cls.last_infer_s}

    @classmethod
    def predict(cls, values: np.ndarray, horizon: int) -> np.ndarray:
        """(horizon, 3) array of p10, p50, p90 for one series (NaN allowed: the model interpolates)."""
        with cls._lock:
            m = cls._load()
            t0 = time.perf_counter()
            _, q = m.forecast(horizon=horizon, inputs=[np.asarray(values, dtype=np.float32)])
            cls.last_infer_s = round(time.perf_counter() - t0, 3)
        q = q[0]  # (horizon, 10): mean, p10 ... p90
        return np.stack([q[:, 1], q[:, 5], q[:, 9]], axis=1)

    @classmethod
    def predict_many(cls, series: list[np.ndarray], horizon: int) -> list[np.ndarray]:
        with cls._lock:
            m = cls._load()
            t0 = time.perf_counter()
            _, q = m.forecast(horizon=horizon, inputs=[np.asarray(s, dtype=np.float32) for s in series])
            cls.last_infer_s = round(time.perf_counter() - t0, 3)
        return [np.stack([x[:, 1], x[:, 5], x[:, 9]], axis=1) for x in q]


def timesfm_forecast(h: History, targets: list[str]) -> list[dict]:
    """Forecast the given target months (all after h.last). Starts from the last observed month, so a trailing
    gap is forecast through, never filled."""
    last_obs = int(np.flatnonzero(h.observed | h.imputed)[-1])
    series = h.values[: last_obs + 1]
    steps = month_diff(h.months[last_obs], targets[-1])
    if steps > 128:
        raise BadRequest("forecast horizon too long")
    q = TimesFM.predict(series, steps)
    return _rows(q, h.months[last_obs], targets)


def _rows(q: np.ndarray, origin: str, targets: list[str]) -> list[dict]:
    out = []
    for t in targets:
        p10, p50, p90 = sorted(float(x) for x in q[month_diff(origin, t) - 1])  # enforce monotone quantiles
        out.append({"month": t, "p10": p10, "p50": p50, "p90": p90})
    return out


def run_method(method: str, h: History, targets: list[str]) -> list[dict]:
    if method == "timesfm":
        return timesfm_forecast(h, targets)
    if method == "climatology":
        return climatology(h, targets)
    raise BadRequest(f"unknown method '{method}'")


def resolve_method(requested: str | None, default: str | None = None) -> str:
    m = requested or default or config.FORECAST_METHOD
    if (m == "timesfm" or default == "timesfm") and not config.TIMESFM_ENABLED:
        raise BadRequest("TimesFM is disabled on this deployment (GEO_TIMESFM=1 enables it): it was not better than "
                         "monthly climatology on our backtest (eval/RESULTS.md), so forecasting is not offered by default")
    return m


def method_info(method: str) -> dict:
    if method == "timesfm":
        return TimesFM.info()
    return {"id": "monthly-climatology", "revision": "v1", "method": "climatology", "license": "n/a",
            "description": "mean of the same calendar month in earlier years, t prediction interval (p10-p90)"}


# ---------- anomaly ----------
def anomaly_verdict(observed: float | None, p10: float, p50: float, p90: float) -> tuple[str, float | None]:
    """Position of the observation against the expected range. `score` is (obs - p50) / sigma with sigma taken from
    the p10-p90 width (sigma = (p90 - p10) / 2 / 1.2816), so |score| > 1.28 is outside the central 80% range."""
    if observed is None:
        return "cannot_determine", None
    sigma = (p90 - p10) / (2 * Z90)
    score = None if sigma <= 1e-9 else round((observed - p50) / sigma, 2)
    if observed < p10:
        return "below_expected", score
    if observed > p90:
        return "above_expected", score
    return "within_expected", score


def backtest_reference(method: str) -> dict | None:
    """Measured accuracy of this method from the committed backtest (eval/RESULTS.md); None when not measured."""
    import json
    from pathlib import Path

    f = Path(__file__).with_name("backtest_summary.json")
    try:
        d = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    return d.get("methods", {}).get(method)
