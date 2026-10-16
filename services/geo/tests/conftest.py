import json
from pathlib import Path

import pystac
import pytest
from fastapi.testclient import TestClient
from pyproj import Transformer

from app import config

FIX = Path(__file__).parent / "fixtures"
# interior of the fixture grid (UTM 43N), inset so no AOI pixel falls outside the rasters
X0, Y0 = 420040.0, 3444690.0
X1, Y1 = 420280.0, 3444960.0


def utm_to_ll(x, y):
    return Transformer.from_crs(32643, 4326, always_xy=True).transform(x, y)


@pytest.fixture
def aoi_bbox():
    w, s = utm_to_ll(X0, Y0)
    e, n = utm_to_ll(X1, Y1)
    return [w, s, e, n]


@pytest.fixture
def fixture_items():
    doc = json.loads((FIX / "items.json").read_text())
    out = []
    for d in doc["items"]:
        for a in d["assets"].values():
            a["href"] = str(FIX / a["href"])
        out.append(pystac.Item.from_dict(d))
    return out


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "cache")
    return tmp_path / "cache"


@pytest.fixture
def client(cache_dir):
    from app.main import app
    return TestClient(app)
