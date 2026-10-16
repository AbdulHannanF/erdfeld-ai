class GeoError(Exception):
    status = 500
    code = "internal_error"

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class FetchFailed(GeoError):
    """Upstream (STAC / COG read) failed. Distinct from 'no data'."""
    status = 502
    code = "fetch_failed"


class BadRequest(GeoError):
    status = 422
    code = "bad_request"


class TooLarge(GeoError):
    status = 413
    code = "too_large"


class NotFound(GeoError):
    status = 404
    code = "not_found"
