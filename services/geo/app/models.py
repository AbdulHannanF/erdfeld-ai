from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

DEFAULT_SCL_KEEP = [4, 5, 6, 7, 11]  # see engine.py for the rationale
COLLECTION = "sentinel-2-l2a"


class AOI(BaseModel):
    bbox: list[float] | None = Field(None, description="[west, south, east, north] in EPSG:4326")
    geometry: dict | None = Field(None, description="GeoJSON Polygon/MultiPolygon (or Feature) in EPSG:4326")

    @field_validator("bbox")
    @classmethod
    def _bbox(cls, v):
        if v is None:
            return v
        if len(v) != 4 or not (v[0] < v[2] and v[1] < v[3]) or not (-180 <= v[0] <= 180 and -90 <= v[1] <= 90
                                                                   and -180 <= v[2] <= 180 and -90 <= v[3] <= 90):
            raise ValueError("bbox must be [west, south, east, north] within lon/lat bounds, west<east, south<north")
        return v

    @model_validator(mode="after")
    def _one_aoi(self):
        if (self.bbox is None) == (self.geometry is None):
            raise ValueError("provide exactly one of bbox or geometry")
        return self


class _Search(AOI):
    start: date
    end: date
    collection: str = COLLECTION
    max_cloud: float | None = Field(None, ge=0, le=100, description="scene-level eo:cloud_cover upper bound (%)")
    resolution: float = Field(10.0, ge=1, le=1000, description="output pixel size in metres (UTM)")
    scl_keep: list[int] = Field(default_factory=lambda: list(DEFAULT_SCL_KEEP),
                                description="SCL classes treated as clear")

    @model_validator(mode="after")
    def _dates(self):
        if self.end < self.start:
            raise ValueError("end must be >= start")
        if self.collection != COLLECTION:
            raise ValueError(f"only '{COLLECTION}' is supported (SCL masking is Sentinel-2 specific)")
        if not self.scl_keep or any(c < 0 or c > 11 for c in self.scl_keep):
            raise ValueError("scl_keep must be a non-empty list of SCL classes 0..11")
        return self


class CompositeRequest(_Search):
    bands: list[str] | None = None
    expression: str | None = Field(None, description="NDVI|NDWI|NDBI|EVI|NBR|SAVI or a formula over band names")

    @model_validator(mode="after")
    def _what(self):
        if bool(self.bands) == bool(self.expression):
            raise ValueError("provide exactly one of bands or expression")
        return self


class TimeseriesRequest(_Search):
    expression: str | None = None
    band: str | None = None
    interval: Literal["scene", "month"] = "scene"

    @model_validator(mode="after")
    def _what(self):
        if bool(self.band) == bool(self.expression):
            raise ValueError("provide exactly one of band or expression")
        return self


class ZonalRequest(BaseModel):
    features: dict = Field(description="GeoJSON FeatureCollection (EPSG:4326) of Polygon/MultiPolygon")
    source: str = Field(description="composite id from POST /composite")
    stats: list[str] = Field(default_factory=lambda: ["mean", "median", "min", "max", "count", "valid_pct"])


class _Series(AOI):
    expression: str = Field("NDVI", description="NDVI|NDWI|NDBI|EVI|NBR|SAVI or a formula, as for /timeseries")
    resolution: float = Field(20.0, ge=10, le=1000, description="output pixel size in metres (UTM); 20 m by default")
    method: Literal["timesfm", "climatology"] | None = Field(None, description="override the deployment default (diagnostics)")


class ForecastRequest(_Series):
    history_start: date
    history_end: date
    horizon_months: int = Field(6, ge=1, le=12)
    interval: Literal["month"] = "month"

    @model_validator(mode="after")
    def _dates(self):
        if self.history_end < self.history_start:
            raise ValueError("history_end must be >= history_start")
        return self


class AnomalyRequest(_Series):
    target_month: str = Field(description="YYYY-MM, the month to judge")
    history_years: int = Field(5, ge=3, le=10)
