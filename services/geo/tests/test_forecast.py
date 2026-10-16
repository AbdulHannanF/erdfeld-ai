"""Forecast / anomaly: gap + refusal logic, wrapper shape, verdicts, endpoints. Offline (fetch stubbed); the real
TimesFM weights are only loaded with TFM_LIVE=1."""
import math
import os

import numpy as np
import pytest

from app import config, forecast as fc, main


def raw_series(first="2019-01", n=60, drop=(), vp=90.0, amp=0.25, base=0.5):
    months = fc.month_range(first, fc.month_add(first, n - 1))
    out = {}
    for i, m in enumerate(months):
        if m in drop:
            continue
        out[m] = fc.RawMonth(base + amp * math.sin(2 * math.pi * (int(m[5:7]) - 1) / 12), vp, 3)
    return out, months[0], months[-1]


def test_month_helpers():
    assert fc.month_add("2025-11", 3) == "2026-02" and fc.month_diff("2024-12", "2026-02") == 14
    assert fc.month_range("2025-11", "2026-01") == ["2025-11", "2025-12", "2026-01"]


def test_short_gaps_interpolated_long_gaps_not():
    raw, a, b = raw_series(drop={"2020-03", "2020-04", "2021-06", "2021-07", "2021-08"})
    h = fc.prepare_history(raw, a, b)
    imp = [m for m, i in zip(h.months, h.imputed) if i]
    assert imp == ["2020-03", "2020-04"]                       # 2-month gap filled
    i = h.months.index("2020-03")
    assert 0 < h.values[i] < 1 and h.observed[i] is np.False_
    assert np.isnan(h.values[h.months.index("2021-07")]) and h.unfilled_gap_months == 3  # 3-month gap left open
    assert h.rows()[h.months.index("2021-07")]["value"] is None
    assert any("not filled" in w for w in h.warnings)


def test_low_valid_pct_month_is_a_gap():
    raw, a, b = raw_series()
    raw["2020-05"] = fc.RawMonth(0.9, 10.0, 1)  # 10% of the AOI: not representative
    h = fc.prepare_history(raw, a, b)
    assert h.imputed[h.months.index("2020-05")] and not h.observed[h.months.index("2020-05")]


@pytest.mark.parametrize("kw,needle", [
    (dict(n=30), "only 30 months"),
    (dict(n=48, drop={fc.month_add("2019-01", i) for i in range(0, 48, 3)}), "too sparse"),
    (dict(n=48, drop={"2022-10", "2022-11", "2022-12"}), "stale"),
])
def test_refusals(kw, needle):
    raw, a, b = raw_series(**kw)
    with pytest.raises(fc.InsufficientHistory, match=needle):
        fc.prepare_history(raw, a, b)


def test_exactly_25pct_missing_is_allowed_and_leading_gap_trimmed():
    raw, a, b = raw_series(n=48, drop={fc.month_add("2019-01", i) for i in range(0, 48, 4)})  # 25%: 12 of 48
    fc.prepare_history(raw, a, b)
    raw, a, b = raw_series(n=60, drop={fc.month_add("2019-01", i) for i in range(0, 12)})
    h = fc.prepare_history(raw, a, b)
    assert h.months[0] == "2020-01" and h.trimmed_from == "2019-01" and len(h.months) == 48


def test_climatology_shape_and_monotone():
    raw, a, b = raw_series(n=60)
    h = fc.prepare_history(raw, a, b)
    t = [fc.month_add(b, i) for i in range(1, 7)]
    rows = fc.climatology(h, t)
    assert [r["month"] for r in rows] == t
    for r in rows:
        assert r["p10"] <= r["p50"] <= r["p90"]
    assert math.isclose(rows[0]["p50"], raw["2023-01"].value, abs_tol=1e-9)  # exactly periodic series


def test_rows_enforce_monotone_quantiles():
    q = np.array([[0.6, 0.5, 0.7], [0.4, 0.45, 0.43]])  # crossed
    for r in fc._rows(q, "2024-12", ["2025-01", "2025-02"]):
        assert r["p10"] <= r["p50"] <= r["p90"]


def test_timesfm_wrapper_starts_from_last_observation(monkeypatch):
    raw, a, b = raw_series(n=48, drop={"2022-11", "2022-12"} | set())
    raw.pop("2022-12", None)
    h = fc.prepare_history(raw, a, b)  # b = 2022-12, last obs 2022-10 => trailing gap 2
    assert h.last == "2022-12"
    seen = {}

    def fake(values, horizon):
        seen["n"], seen["h"], seen["last"] = len(values), horizon, values[-1]
        return np.tile([0.4, 0.5, 0.6], (horizon, 1))

    monkeypatch.setattr(fc.TimesFM, "predict", staticmethod(fake))
    out = fc.timesfm_forecast(h, ["2023-01", "2023-02"])
    assert seen["h"] == 4 and seen["n"] == 46 and not np.isnan(seen["last"])  # forecast THROUGH the trailing gap
    assert [r["month"] for r in out] == ["2023-01", "2023-02"]


def test_anomaly_verdicts():
    assert fc.anomaly_verdict(0.30, 0.4, 0.5, 0.6)[0] == "below_expected"
    assert fc.anomaly_verdict(0.7, 0.4, 0.5, 0.6)[0] == "above_expected"
    v, s = fc.anomaly_verdict(0.55, 0.4, 0.5, 0.6)
    assert v == "within_expected" and 0 < s < 1.29
    assert fc.anomaly_verdict(None, 0.4, 0.5, 0.6) == ("cannot_determine", None)
    assert fc.anomaly_verdict(0.6, 0.4, 0.5, 0.6)[0] == "within_expected"  # boundary is inside the range


# ---------- endpoints (fetch stubbed) ----------
@pytest.fixture
def stub_fetch(monkeypatch):
    def install(raw):
        def fake(geom, expression, first, last, resolution, scl_keep):
            sel = {m: r for m, r in raw.items() if first <= m <= last}
            return fc.Fetched(sel, {f"S2X_{m}" for m in sel}, "(nir-red)/(nir+red)", "ndvi")
        monkeypatch.setattr(fc, "fetch_monthly", fake)
    monkeypatch.setattr(config, "FORECAST_METHOD", "climatology")
    monkeypatch.setattr(config, "TIMESFM_ENABLED", True)
    return install


AOI = {"geometry": {"type": "Polygon", "coordinates": [[[74.05, 31.12], [74.08, 31.12], [74.08, 31.15], [74.05, 31.15], [74.05, 31.12]]]}}


def test_forecast_endpoint(client, stub_fetch):
    raw, a, b = raw_series("2019-01", 60, drop={"2021-02"})
    stub_fetch(raw)
    r = client.post("/forecast", json={**AOI, "history_start": "2019-01-01", "history_end": "2023-12-31", "horizon_months": 6, "method": "climatology"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert len(d["history"]) == 60 and len(d["forecast"]) == 6 and d["forecast"][0]["month"] == "2024-01"
    assert all(f["p10"] <= f["p50"] <= f["p90"] for f in d["forecast"])
    assert d["imputed_months"] == ["2021-02"] and d["model"]["method"] == "climatology" and d["kind"] == "forecast"
    assert d["history"][25]["imputed"] is True
    assert d["provenance"]["item_count"] == 59


def test_forecast_refuses_short_history_and_long_horizon(client, stub_fetch):
    raw, a, b = raw_series("2022-01", 30)
    stub_fetch(raw)
    r = client.post("/forecast", json={**AOI, "history_start": "2022-01-01", "history_end": "2024-06-30"})
    assert r.status_code == 422 and r.json()["error"] == "insufficient_history" and "30 months" in r.json()["detail"]
    r = client.post("/forecast", json={**AOI, "history_start": "2019-01-01", "history_end": "2023-12-31", "horizon_months": 13})
    assert r.status_code == 422 and r.json()["error"] == "bad_request"


def test_anomaly_endpoint(client, stub_fetch):
    raw, a, b = raw_series("2019-01", 84, amp=0.25)   # through 2025-12, perfectly periodic
    stub_fetch(raw)
    body = {**AOI, "target_month": "2025-06", "history_years": 5}
    # periodic series -> sd 0 -> degenerate range; add year-to-year noise to the history
    rng = np.random.default_rng(1)
    for m in list(raw):
        raw[m] = fc.RawMonth(raw[m].value + float(rng.normal(0, 0.02)), 90.0, 3)
    raw["2025-06"] = fc.RawMonth(0.5 + 0.25 * math.sin(2 * math.pi * 5 / 12), 90.0, 3)  # the noiseless mean
    d = client.post("/anomaly", json=body).json()
    assert d["verdict"] == "within_expected" and d["expected_p10"] < d["expected_p50"] < d["expected_p90"]
    raw["2025-06"] = fc.RawMonth(raw["2025-06"].value - 0.3, 90.0, 3)
    assert client.post("/anomaly", json=body).json()["verdict"] == "below_expected"
    raw["2025-06"] = fc.RawMonth(raw["2025-06"].value + 0.6, 90.0, 3)
    assert client.post("/anomaly", json=body).json()["verdict"] == "above_expected"
    raw["2025-06"] = fc.RawMonth(0.2, 5.0, 1)   # cloudy: <30% valid
    d = client.post("/anomaly", json=body).json()
    assert d["verdict"] == "cannot_determine" and d["observed"] is None and "no clear observation" in d["reason"]
    assert d["expected_p50"] is not None


def test_anomaly_sparse_history_is_cannot_determine_and_future_is_422(client, stub_fetch):
    raw, a, b = raw_series("2019-01", 84, drop={fc.month_add("2019-01", i) for i in range(0, 84, 2)})
    stub_fetch(raw)
    d = client.post("/anomaly", json={**AOI, "target_month": "2025-06"}).json()
    assert d["verdict"] == "cannot_determine" and "too short or sparse" in d["reason"]
    r = client.post("/anomaly", json={**AOI, "target_month": "2099-01"})
    assert r.status_code == 422


def test_timesfm_flag_off_refuses_forecast_and_timesfm_anomaly(client, stub_fetch, monkeypatch):
    stub_fetch({})
    monkeypatch.setattr(config, "TIMESFM_ENABLED", False)
    r = client.post("/anomaly", json={**AOI, "target_month": "2025-06", "method": "timesfm"})
    assert r.status_code == 422 and "disabled" in r.json()["detail"]
    r = client.post("/forecast", json={**AOI, "history_start": "2019-01-01", "history_end": "2023-12-31"})
    assert r.status_code == 422 and "disabled" in r.json()["detail"]


def test_default_config_ships_climatology_only():
    import importlib
    assert config.FORECAST_METHOD == "climatology"
    importlib.reload(config)
    assert config.TIMESFM_ENABLED is False


@pytest.mark.skipif(os.environ.get("TFM_LIVE") != "1", reason="downloads TimesFM weights; set TFM_LIVE=1")
def test_timesfm_live_seasonal_series():
    raw, a, b = raw_series("2018-01", 72, amp=0.25)
    rng = np.random.default_rng(0)
    raw = {m: fc.RawMonth(r.value + float(rng.normal(0, 0.02)), 90.0, 3) for m, r in raw.items()}
    h = fc.prepare_history(raw, a, b)
    rows = fc.timesfm_forecast(h, [fc.month_add(b, i) for i in range(1, 7)])
    assert len(rows) == 6
    for r in rows:
        assert r["p10"] <= r["p50"] <= r["p90"]
        truth = 0.5 + 0.25 * math.sin(2 * math.pi * (int(r["month"][5:7]) - 1) / 12)
        assert abs(r["p50"] - truth) < 0.1
    assert fc.TimesFM.load_s is not None and fc.TimesFM.revision == config.TIMESFM_REVISION
