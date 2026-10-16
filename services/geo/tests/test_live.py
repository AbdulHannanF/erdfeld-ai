"""Opt-in live test against Earth Search (GEO_LIVE=1). Needs internet; GDAL must reach the COG bucket."""
import os
import time

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("GEO_LIVE") != "1", reason="set GEO_LIVE=1 to run live tests")

KASUR = dict(bbox=[74.05, 31.12, 74.08, 31.15], start="2026-09-01", end="2026-09-30", expression="NDVI")


def test_kasur_ndvi_composite_live(client):
    t0 = time.time()
    r = client.post("/composite", json=KASUR)
    cold = time.time() - t0
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["item_count"] > 0 and j["id"]
    s = j["stats"]["ndvi"]
    print(f"\nLIVE kasur: items={j['item_count']} days={j['scene_days']} valid={j['valid_pixel_pct']}% "
          f"ndvi p2={s['p2']:.3f} p98={s['p98']:.3f} cold={cold:.1f}s")
    assert j["valid_pixel_pct"] > 50
    assert -1 <= s["min"] <= s["max"] <= 1 and s["p2"] < s["p98"]
    t0 = time.time()
    r2 = client.post("/composite", json=KASUR).json()
    warm = time.time() - t0
    print(f"LIVE cache hit: {warm:.2f}s")
    assert r2["cached"] is True and r2["id"] == j["id"]
    assert client.get(f"/composite/{j['id']}/tiles/14/11562/6699.png").status_code == 200
