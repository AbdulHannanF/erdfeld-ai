"""Safe band-math. Only + - * / ** , unary +/-, numbers, parentheses and band names are allowed.

Band names are Earth Search asset keys (red, nir, swir16 ...); Sentinel-2 B-numbers are aliased.
Values are surface reflectance (DN * 1e-4, offset already removed by Earth Search; see engine.py).
Index formulas match src/app/api/agent/lib/titiler.ts SPECTRAL_INDICES exactly."""
import ast
import operator
from dataclasses import dataclass

import numpy as np

from .errors import BadRequest

ALIASES = {
    "b02": "blue", "b03": "green", "b04": "red", "b05": "rededge1", "b06": "rededge2",
    "b07": "rededge3", "b08": "nir", "b8a": "nir08", "b09": "nir09", "b11": "swir16", "b12": "swir22",
}
ASSET_KEYS = {"coastal", "blue", "green", "red", "rededge1", "rededge2", "rededge3", "nir", "nir08",
              "nir09", "swir16", "swir22"}

INDICES = {
    "NDVI": "(nir-red)/(nir+red)",
    "NDWI": "(green-nir)/(green+nir)",
    "NDBI": "(swir16-nir)/(swir16+nir)",
    "EVI": "2.5*(nir-red)/(nir+6*red-7.5*blue+1)",
    "NBR": "(nir-swir22)/(nir+swir22)",
    "SAVI": "1.5*(nir-red)/(nir+red+0.5)",
}

_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow}
_UN = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def canonical_band(name: str) -> str:
    n = name.strip().lower()
    n = ALIASES.get(n, n)
    if n not in ASSET_KEYS:
        raise BadRequest(f"unknown band '{name}'. Use Earth Search keys ({', '.join(sorted(ASSET_KEYS))}) or B02..B12.")
    return n


@dataclass
class Compiled:
    source: str  # canonical formula text
    name: str    # output band name
    tree: ast.AST
    bands: list[str]

    def __call__(self, env: dict[str, np.ndarray]) -> np.ndarray:
        with np.errstate(divide="ignore", invalid="ignore"):
            out = np.asarray(self._ev(self.tree.body, env), dtype=np.float32)  # type: ignore[attr-defined]
        out = np.where(np.isfinite(out), out, np.nan).astype(np.float32)  # x/0 is "undefined", not a value
        return out

    def _ev(self, n: ast.AST, env):
        if isinstance(n, ast.BinOp) and type(n.op) in _BIN:
            return _BIN[type(n.op)](self._ev(n.left, env), self._ev(n.right, env))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _UN:
            return _UN[type(n.op)](self._ev(n.operand, env))
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return n.value
        if isinstance(n, ast.Name):
            return env[canonical_band(n.id)]
        raise BadRequest("unsupported expression element")


def compile_expression(text: str) -> Compiled:
    raw = text.strip()
    if not raw or len(raw) > 300:
        raise BadRequest("expression is empty or too long")
    name = raw.lower() if raw.upper() in INDICES else "expression"
    formula = INDICES.get(raw.upper(), raw)
    try:
        tree = ast.parse(formula, mode="eval")
    except SyntaxError as e:
        raise BadRequest(f"cannot parse expression: {e.msg}") from e
    bands: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            b = canonical_band(node.id)
            if b not in bands:
                bands.append(b)
        elif not isinstance(node, (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Load,
                                   *_BIN, *_UN)):
            raise BadRequest(f"unsupported expression element: {type(node).__name__}")
    if not bands:
        raise BadRequest("expression references no bands")
    c = Compiled(source=formula, name=name, tree=tree, bands=bands)
    return c
