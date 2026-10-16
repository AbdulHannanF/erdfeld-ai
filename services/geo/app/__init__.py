"""GeoAgent geo service. Importing this package configures GDAL for remote COG reads."""
from .config import configure_gdal

configure_gdal()
