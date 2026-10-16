import os
from pathlib import Path

# GDAL settings for fast remote-COG reads. setdefault so deployment can override.
GDAL_DEFAULTS = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": "268435456",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.tiff,.TIF,.TIFF",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "1",
}

STAC_URL = os.environ.get("GEO_STAC_URL", "https://earth-search.aws.element84.com/v1")
CACHE_DIR = Path(os.environ.get("GEO_CACHE_DIR", ".cache/composites"))
MAX_PIXELS = int(os.environ.get("GEO_MAX_PIXELS", 25_000_000))  # per-layer AOI grid
MAX_STACK_ELEMENTS = int(os.environ.get("GEO_MAX_STACK_ELEMENTS", 300_000_000))  # pixels x scenes x bands
MAX_ITEMS = int(os.environ.get("GEO_MAX_ITEMS", 200))
MAX_FEATURES = int(os.environ.get("GEO_MAX_FEATURES", 5000))
PUBLIC_URL = os.environ.get("GEO_PUBLIC_URL", "").rstrip("/")


def configure_gdal() -> None:
    for k, v in GDAL_DEFAULTS.items():
        os.environ.setdefault(k, v)
    # GDAL's libcurl needs the sandbox/corporate CA; honour the usual env vars.
    ca = os.environ.get("CURL_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    if ca:
        os.environ.setdefault("CURL_CA_BUNDLE", ca)

# Forecasting (app/forecast.py). TimesFM 2.5 only: its weights are Apache-2.0. TimesFM 3.0 weights are
# NON-COMMERCIAL (timesfm-non-commercial-license-v1.0) and must not be used here.
TIMESFM_MODEL_ID = "google/timesfm-2.5-200m-pytorch"
TIMESFM_REVISION = os.environ.get("GEO_TIMESFM_REVISION", "1d952420fba87f3c6dee4f240de0f1a0fbc790e3")
# Backtest decision (eval/RESULTS.md): TimesFM 2.5 was NOT better than monthly climatology at 3-month lead on a
# majority of AOIs, so /anomaly uses climatology and TimesFM (+ the /forecast endpoint) stays behind this flag.
FORECAST_METHOD = "climatology"
TIMESFM_ENABLED = os.environ.get("GEO_TIMESFM", "0") == "1"
