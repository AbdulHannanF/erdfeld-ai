"""Deterministic, offline tests on the committed synthetic stack (see make_fixtures.py)."""
import math

import numpy as np
import rasterio
from pyproj import Transformer

from app import engine, main, store
from app.models import CompositeRequest, TimeseriesRequest

UTM = Transformer.from_crs(32643, 4326, always_xy=True)


def sample(path, x, y, band=1):
    with rasterio.open(path) as src:
        return float(next(src.sample([(x, y)], indexes=band))[0])


def req(aoi_bbox, **kw):
    base = dict(bbox=aoi_bbox, start="2026-09-01", end="2026-09-30")
    return CompositeRequest(**{**base, **kw})


def test_median_and_scl_mask(aoi_bbox, fixture_items, cache_dir):
    out = main.run_composite(req(aoi_bbox, bands=["red", "nir"]), fixture_items)
    p = store.cog_path(out["id"])
    # left half: dates 3 (SCL 9) and 4 (SCL 3 shadow) dropped -> median(1000,2000,1500)=1500 DN
    assert math.isclose(sample(p, 420100, 3444900, 1), 0.15, abs_tol=1e-6)
    assert math.isclose(sample(p, 420100, 3444900, 2), 0.30, abs_tol=1e-6)
    # right half: dates 1 (cloud 8) and 3 (cirrus 10) dropped -> median(1000,3000,2000)=2000 DN
    assert math.isclose(sample(p, 420220, 3444900, 1), 0.20, abs_tol=1e-6)
    # nir no-data block on date 0 removes that date there -> red median(2000,1500)=1750, nir median(4000,3000)=3500
    assert math.isclose(sample(p, 420085, 3444895, 1), 0.175, abs_tol=1e-6)
    assert math.isclose(sample(p, 420085, 3444895, 2), 0.35, abs_tol=1e-6)
    # bottom rows are cloud on every date: no observation -> NaN, never a fabricated value
    assert math.isnan(sample(p, 420100, 3444700, 1))
    assert out["item_count"] == 5 and out["scene_days"] == 5
    assert 0 < out["valid_pixel_pct"] < 100 and out["cached"] is False
    assert math.isclose(out["stats"]["red"]["min"], 0.15, abs_tol=1e-6) and math.isclose(out["stats"]["red"]["max"], 0.2, abs_tol=1e-6)


def test_ndvi_is_index_of_median(aoi_bbox, fixture_items, cache_dir):
    out = main.run_composite(req(aoi_bbox, expression="NDVI"), fixture_items)
    s = out["stats"]["ndvi"]
    assert math.isclose(s["min"], 1 / 3, abs_tol=1e-6) and math.isclose(s["max"], 1 / 3, abs_tol=1e-6)
    assert out["expression"] == "(nir-red)/(nir+red)"


def test_scl_keep_changes_result_and_hash(aoi_bbox, fixture_items, cache_dir):
    a = main.run_composite(req(aoi_bbox, bands=["red"]), fixture_items)
    b = main.run_composite(req(aoi_bbox, bands=["red"], scl_keep=[4, 5, 6, 7, 8, 9, 10, 3, 11]), fixture_items)
    assert a["id"] != b["id"]
    # keeping clouds/shadow: left median of all 5 = 2000, bottom rows now valid
    assert b["valid_pixel_pct"] == 100.0 and b["stats"]["red"]["max"] > a["stats"]["red"]["max"] - 1e-9


def test_hash_deterministic_and_sensitive(aoi_bbox, fixture_items):
    def cid(r, items):
        plan = engine.make_plan(r.bands, r.expression)
        return store.composite_id(store.canonical_request(r, plan), [i.id for i in items])
    r = req(aoi_bbox, bands=["B04", "nir"])
    base = cid(r, fixture_items)
    assert cid(r, list(reversed(fixture_items))) == base            # item order irrelevant
    assert cid(req(aoi_bbox, bands=["red", "nir"]), fixture_items) == base  # B04 == red
    assert cid(r, fixture_items[:-1]) != base                         # new scene set -> new id
    assert cid(req(aoi_bbox, bands=["red", "nir"], resolution=20), fixture_items) != base
    shifted = [aoi_bbox[0] + 0.001, *aoi_bbox[1:]]
    assert cid(req(shifted, bands=["red", "nir"]), fixture_items) != base


def test_cache_hit_does_not_recompute(aoi_bbox, fixture_items, cache_dir, monkeypatch):
    r = req(aoi_bbox, expression="ndvi")
    first = main.run_composite(r, fixture_items)
    monkeypatch.setattr(engine, "load_stack", lambda *a, **k: (_ for _ in ()).throw(AssertionError("recomputed")))
    second = main.run_composite(r, fixture_items)
    assert second["cached"] is True and second["id"] == first["id"] and second["created"] == first["created"]


def test_timeseries_scene_and_month(aoi_bbox, fixture_items):
    tr = TimeseriesRequest(bbox=aoi_bbox, start="2026-09-01", end="2026-09-30", band="red", interval="scene")
    plan = engine.make_plan([tr.band], None)
    st = engine.load_stack(fixture_items, main._geom(tr), plan, 10.0, tr.scl_keep)
    rows = engine.timeseries(st, plan, "scene")
    assert [r["date"] for r in rows][0] == "2026-09-02" and len(rows) == 5
    # date 3 (2026-09-17): left cloud (9), right cirrus (10) -> nothing valid, reported as null not 0
    assert rows[3]["n_valid"] == 0 and rows[3]["mean"] is None and rows[3]["valid_pct"] == 0.0
    # date 0: all clear except bottom rows and the nir-less block is irrelevant for red alone
    assert math.isclose(rows[0]["mean"], 0.1, abs_tol=1e-6) and rows[0]["valid_pct"] > 80
    m = engine.timeseries(st, plan, "month")
    assert len(m) == 1 and m[0]["date"] == "2026-09" and m[0]["n_scenes"] == 5
    assert m[0]["valid_pct"] < 100  # bottom rows never valid


def test_http_endpoints(client, aoi_bbox, fixture_items, monkeypatch):
    monkeypatch.setattr(engine, "search_items", lambda r: fixture_items)
    body = dict(bbox=aoi_bbox, start="2026-09-01", end="2026-09-30", expression="NDVI")
    r = client.post("/composite", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["tile_url_template"].endswith(f"/composite/{j['id']}/tiles/{{z}}/{{x}}/{{y}}.png")
    assert client.post("/composite", json=body).json()["cached"] is True
    # tile covering the AOI
    import mercantile
    lon, lat = UTM.transform(420150, 3444800)
    t = mercantile.tile(lon, lat, 17)
    png = client.get(f"/composite/{j['id']}/tiles/{t.z}/{t.x}/{t.y}.png?rescale=0,1&colormap_name=viridis")
    assert png.status_code == 200 and png.content[:4] == b"\x89PNG"
    assert png.content[25] == 6  # IHDR colour type 6 = RGBA: the colormap was applied
    plain = client.get(f"/composite/{j['id']}/tiles/{t.z}/{t.x}/{t.y}.png?rescale=0,1")
    assert plain.content[25] == 4  # grey + alpha without a colormap
    assert client.get(f"/composite/{j['id']}.tif").headers["content-type"] == "image/tiff"
    assert client.get("/composite/nope/tiles/1/1/1.png").status_code == 404
    # zonal: polygon over the left (valid, ndvi=1/3) half, one over the cloudy bottom rows
    def poly(x0, y0, x1, y1):
        pts = [UTM.transform(*p) for p in [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]
        return {"type": "Polygon", "coordinates": [[list(p) for p in pts]]}
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": "left", "properties": {"n": 1}, "geometry": poly(420050, 3444800, 420110, 3444900)},
        {"type": "Feature", "id": "bottom", "properties": {}, "geometry": poly(420050, 3444685, 420110, 3444715)},
    ]}
    z = client.post("/zonal", json={"features": fc, "source": j["id"], "stats": ["mean", "min", "count", "valid_pct"]})
    assert z.status_code == 200, z.text
    left, bottom = z.json()["results"]
    assert math.isclose(left["stats"]["ndvi"]["mean"], 1 / 3, abs_tol=1e-5)
    assert left["stats"]["ndvi"]["valid_pct"] == 100.0 and left["id"] == "left"
    assert bottom["stats"]["ndvi"]["mean"] is None and bottom["stats"]["ndvi"]["valid_pct"] == 0.0


def test_errors_are_explicit(client, aoi_bbox, monkeypatch):
    body = dict(bbox=aoi_bbox, start="2026-09-01", end="2026-09-30", expression="NDVI")
    monkeypatch.setattr(engine, "search_items", lambda r: [])
    j = client.post("/composite", json=body).json()
    assert j["item_count"] == 0 and j["id"] is None and "No sentinel-2-l2a scenes" in j["message"]
    from app.errors import FetchFailed

    def boom(r):
        raise FetchFailed("STAC search failed: timeout")
    monkeypatch.setattr(engine, "search_items", boom)
    r = client.post("/composite", json=body)
    assert r.status_code == 502 and r.json()["error"] == "fetch_failed" and "timeout" in r.json()["detail"]
    assert client.post("/composite", json={**body, "expression": "nir+evil()"}).status_code == 422
    assert client.post("/composite", json={**body, "bands": ["red"]}).status_code == 422
