FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /srv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
# rasterio / pyproj / exactextract / shapely ship manylinux wheels with GDAL+PROJ+GEOS bundled: no system GDAL.
# TimesFM + torch (~1 GB) are an optional extra and stay out unless asked for: --build-arg WITH_TIMESFM=1.
ARG WITH_TIMESFM=0
RUN if [ "$WITH_TIMESFM" = 1 ]; then x="--extra timesfm"; else x=""; fi;     uv sync --frozen --no-dev --no-install-project $x

FROM python:3.13-slim
# rasterio's manylinux wheel links the system libexpat, which the slim base image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 10001 geo && mkdir -p /data/composites && chown -R geo /data
WORKDIR /srv
COPY --from=build /srv/.venv /srv/.venv
COPY app ./app
ENV PATH=/srv/.venv/bin:$PATH PYTHONUNBUFFERED=1 GEO_CACHE_DIR=/data/composites
USER geo
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import os, urllib.request as u; u.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '8100'), timeout=4)"
# One process, one worker: the composite cache and its per-key locks live in this process (and its
# disk), so scale it up, not out. Cloud Run sets PORT; elsewhere it is 8100.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8100}"]
