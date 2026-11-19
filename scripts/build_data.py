"""Build the web data for the forest geoportal from the GEE exports in raw/.

Inputs  (raw/, exported by scripts/gee_export_forest_portal_v2.js + v1 TerraClimate)
  hansen_cover_01deg.tif   treecover2000_mean (% x100), forest2000_frac (x1e4)
  hansen_loss_01deg.tif    loss_frac (x1e4)  forest (>=30 % canopy in 2000) lost 2001-2025
  fire_01deg.tif           burn_rate (x1e4)  mean share of cell burned per year 2001-2025
  terraclimate_01deg.tif   pr, pet, def 1991-2020 (mm/yr), def 1961-1990
  cmip6_*.tif              0.25 deg, NEX-GDDP-CMIP6 5-model mean: tas (K), pr (kg m-2 s-1), hurs (%)
  data/countries-50m.json  Natural Earth 1:50m countries (world-atlas TopoJSON, npm world-atlas@2)

Outputs (data/)
  <var>.png                3600 x 1400 grayscale, EPSG:4326, 0.1 deg, rows 80N -> 60S.
                           code 0 = no data, 1..255 = value on the scale given in meta.json
  countries.png            country index per cell (1..N, order of the TopoJSON features)
  countries.geojson        the same countries cut at ±180° for the web map
  meta.json                grid, encodings, forest-area-weighted percentile tables, key figures

Run:  python scripts/build_data.py   (needs numpy, scipy, rasterio, pillow, shapely)
"""
import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy import ndimage
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "raw", ROOT / "data"
OUT.mkdir(exist_ok=True)

NX, NY, RES, LAT_TOP = 3600, 1400, 0.1, 80.0
lat = LAT_TOP - RES / 2 - RES * np.arange(NY)                     # cell centres
lon = -180 + RES / 2 + RES * np.arange(NX)
R = 6371.0088
band_area = R**2 * np.radians(RES) * (np.sin(np.radians(lat + RES / 2)) - np.sin(np.radians(lat - RES / 2)))
AREA = np.repeat(band_area[:, None], NX, axis=1)                   # km2 per cell

FOREST_MIN = 0.10      # a cell counts as forested for maps 02/03 if >= 10 % of it is forest


def read(name):
    with rasterio.open(RAW / name) as d:
        return d.read().astype("float64"), list(d.descriptions)


def grid01(name):
    a, desc = read(name)
    return {k: a[i, :NY, :NX] for i, k in enumerate(desc)}


# ─────────────── load 0.1 deg layers ───────────────
hc = grid01("hansen_cover_01deg.tif")
canopy = hc["treecover2000_mean"] / 100.0                          # %
forest = hc["forest2000_frac"] / 1e4                               # 0..1 of cell
loss = grid01("hansen_loss_01deg.tif")["loss_frac"] / 1e4          # 0..1 of cell
fire = grid01("fire_01deg.tif")["burn_rate"] / 1e4                 # 0..1 of cell per year
tc = grid01("terraclimate_01deg.tif")
pr_obs, pet_obs = tc["pr_1991_2020"], tc["pet_1991_2020"]
land_tc = pr_obs >= 0
aridity = np.where(land_tc & (pet_obs > 0), np.maximum(pr_obs, 0) / np.where(pet_obs > 0, pet_obs, 1), np.nan)

# ─────────────── countries (TopoJSON -> GeoJSON, same feature order as the web map) ───────────────
def topo_features(path, obj="countries"):
    topo = json.loads(path.read_text())
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        a = np.cumsum(np.array(arc, dtype="float64"), axis=0)
        arcs.append(np.column_stack([a[:, 0] * sx + tx, a[:, 1] * sy + ty]))

    def ring(ids):
        pts = []
        for k, i in enumerate(ids):
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts.append(a if k == 0 else a[1:])
        return np.vstack(pts).tolist()

    out = []
    for g in topo["objects"][obj]["geometries"]:
        if g["type"] == "Polygon":
            geom = {"type": "Polygon", "coordinates": [ring(r) for r in g["arcs"]]}
        elif g["type"] == "MultiPolygon":
            geom = {"type": "MultiPolygon", "coordinates": [[ring(r) for r in p] for p in g["arcs"]]}
        else:
            geom = None
        out.append({"properties": g.get("properties", {}), "geometry": geom})
    return out


def fix_antimeridian(geom, name):
    """Planar maps need polygons cut at ±180°; world-atlas rings jump across it instead."""
    from shapely.geometry import MultiPolygon, Polygon, box, mapping
    from shapely.affinity import translate
    if geom is None or name == "Antarctica":       # outside the data (60°S-80°N); drawn as ocean
        return None
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    parts = []
    for p in polys:
        rings = []
        for r in p:
            a = np.array(r)
            if np.abs(np.diff(a[:, 0])).max() > 180:
                a[:, 0] = np.where(a[:, 0] < 0, a[:, 0] + 360, a[:, 0])
            rings.append(a)
        poly = Polygon(rings[0], rings[1:]).buffer(0)
        west = poly.intersection(box(-180, -90, 180, 90))
        east = translate(poly.intersection(box(180, -90, 540, 90)), -360)
        for g in (west, east):
            if g.is_empty:
                continue
            parts += list(g.geoms) if hasattr(g, "geoms") else [g]
    parts = [g for g in parts if isinstance(g, Polygon) and g.area > 0]
    return mapping(MultiPolygon(parts)) if parts else None


feats = topo_features(OUT / "countries-50m.json")
for f in feats:
    f["geometry"] = fix_antimeridian(f["geometry"], f["properties"].get("name"))


def rounded(obj, nd=3):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], nd), round(obj[1], nd)]
        return [rounded(o, nd) for o in obj]
    return obj


web_geo = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"idx": i + 1, "name": f["properties"].get("name", "")},
     "geometry": None if f["geometry"] is None else
     {"type": f["geometry"]["type"], "coordinates": rounded(f["geometry"]["coordinates"])}}
    for i, f in enumerate(feats)]}
(OUT / "countries.geojson").write_text(json.dumps(web_geo, separators=(",", ":")))
names = [f["properties"].get("name", "") for f in feats]
assert len(feats) < 255
shapes = [(shape(f["geometry"]), i + 1) for i, f in enumerate(feats) if f["geometry"]]
transform = from_origin(-180, LAT_TOP, RES, RES)
country = rasterize(shapes, out_shape=(NY, NX), transform=transform, fill=0, dtype="uint8")
land = country > 0

# ─────────────── CMIP6, 0.25 deg -> 0.1 deg (bilinear, gaps filled by nearest) ───────────────
def cmip(name):
    a, desc = read(name)
    out = {}
    rr = (84.0 - lat) / 0.25 - 0.5
    cc = (lon + 180.0) / 0.25 - 0.5
    R2, C2 = np.meshgrid(rr, cc, indexing="ij")
    for i, k in enumerate(desc):
        b = a[i]
        nan = ~np.isfinite(b)
        idx = ndimage.distance_transform_edt(nan, return_distances=False, return_indices=True)
        b = b[tuple(idx)]
        out[k] = ndimage.map_coordinates(b, [R2, C2], order=1, mode="nearest")
    return out


def vpd(tas_k, hurs):
    t = tas_k - 273.15
    es = 0.6108 * np.exp(17.27 * t / (t + 237.3))
    return es * (1 - np.clip(hurs, 0, 100) / 100)


hist = cmip("cmip6_hist_1995_2014.tif")
SEC_YR = 86400 * 365.25
clim = {}
for scen, f in [("245", "cmip6_ssp245_2041_2060.tif"), ("585", "cmip6_ssp585_2041_2060.tif")]:
    fut = cmip(f)
    p_h, p_f = hist["pr"] * SEC_YR, fut["pr"] * SEC_YR
    clim[scen] = {
        "dt": fut["tas"] - hist["tas"],
        "dp": (p_f - p_h) / np.maximum(p_h, 1) * 100,
        "dvpd": vpd(fut["tas"], fut["hurs"]) - vpd(hist["tas"], hist["hurs"]),
    }

# ─────────────── masks & weights ───────────────
M = land & (forest >= FOREST_MIN)
W = forest * AREA                     # forest area (km2) per cell

# climate stress index: mean of three components scaled on a shared (both-scenario) 2-98 % range
comp_spec = {"dt": 1, "dp": -1, "dvpd": 1}  # sign: + means larger value = more stress
ranges = {}
for k, sgn in comp_spec.items():
    pooled = np.concatenate([sgn * clim[s][k][M] for s in clim])
    ranges[k] = (float(np.percentile(pooled, 2)), float(np.percentile(pooled, 98)))
for s in clim:
    parts = []
    for k, sgn in comp_spec.items():
        lo, hi = ranges[k]
        parts.append(np.clip((sgn * clim[s][k] - lo) / (hi - lo), 0, 1))
    clim[s]["stress"] = np.mean(parts, axis=0)

loss_share = np.where(forest > 0.001, np.clip(loss / np.maximum(forest, 1e-9), 0, 1), np.nan)

# ─────────────── encode ───────────────
def tfun(kind):
    return {"linear": (lambda x: x), "sqrt": np.sqrt, "log": np.log}[kind]


meta_vars = {}


def encode(key, values, mask, vmin, vmax, kind="linear", label="", unit=""):
    t = tfun(kind)
    v = np.clip(values, vmin, vmax)
    u = (t(v) - t(vmin)) / (t(vmax) - t(vmin))
    code = np.where(mask & np.isfinite(values), 1 + np.round(u * 254), 0).astype("uint8")
    Image.fromarray(code, mode="L").save(OUT / f"{key}.png", optimize=True)
    # forest-area-weighted percentile of each code among forested cells (mid-rank)
    sel = M & (code > 0)
    w = np.bincount(code[sel], weights=W[sel], minlength=256)
    cum = np.cumsum(w) - w / 2
    rank = cum / w.sum()
    rank[0] = 0
    meta_vars[key] = {"min": vmin, "max": vmax, "scale": kind, "label": label, "unit": unit,
                      "rank": [round(float(x), 4) for x in rank]}
    return code


encode("forest", forest, land & (forest >= 0.01), 0, 1, "linear", "Forest share of cell", "%")
encode("canopy", canopy, land & (canopy >= 1), 0, 100, "linear", "Mean tree canopy cover", "%")
encode("loss", loss_share, M, 0, 1, "sqrt", "Forest lost 2001–2025", "% of 2000 forest")
encode("fire", fire, M, 0, 1, "sqrt", "Area burned per year", "% of cell")
encode("aridity", aridity, M, 0.03, 5, "log", "Aridity index (P / PET)", "")
for s in clim:
    encode(f"dt_{s}", clim[s]["dt"], M, 0, 5, "linear", "Warming", "°C")
    encode(f"dp_{s}", clim[s]["dp"], M, -40, 40, "linear", "Precipitation change", "%")
    encode(f"dvpd_{s}", clim[s]["dvpd"], M, -0.1, 0.7, "linear", "VPD change", "kPa")
    encode(f"stress_{s}", clim[s]["stress"], M, 0, 1, "linear", "Climate stress index", "")
Image.fromarray(country, mode="L").save(OUT / "countries.png", optimize=True)

# ─────────────── key figures ───────────────
def wmean(x, m):
    return float(np.sum(x[m] * W[m]) / np.sum(W[m]))


fa = float(np.sum(W[land]))
alat = np.abs(lat)[:, None] * np.ones((1, NX))
stats = {
    "forest_area_km2": fa,
    "land_area_km2": float(np.sum(AREA[land])),
    "share_tropics": float(np.sum(W[land & (alat < 23.44)]) / fa),
    "share_mid": float(np.sum(W[land & (alat >= 23.44) & (alat < 50)]) / fa),
    "share_high": float(np.sum(W[land & (alat >= 50)]) / fa),
    "loss_km2": float(np.sum((loss * AREA)[land])),
    "forested_cells_area_km2": float(np.sum(W[M])),
    "fire_gt1": float(np.sum(W[M & (fire > 0.01)]) / np.sum(W[M])),
    "dry_share": float(np.sum(W[M & (aridity < 0.65)]) / np.sum(W[M])),
    "stress_ranges": ranges,
}
by_country = np.bincount(country[land], weights=W[land], minlength=len(feats) + 1)
order = np.argsort(-by_country)
stats["top5_share"] = float(by_country[order[:5]].sum() / fa)
for s in clim:
    c = clim[s]
    stats[f"dt_{s}"] = wmean(c["dt"], M)
    stats[f"drier_{s}"] = float(np.sum(W[M & (c["dp"] < 0)]) / np.sum(W[M]))
    stats[f"dt2_{s}"] = float(np.sum(W[M & (c["dt"] > 2)]) / np.sum(W[M]))
    stats[f"dvpd_{s}"] = wmean(c["dvpd"], M)

meta = {
    "grid": {"nx": NX, "ny": NY, "res": RES, "lat_top": LAT_TOP, "lon_left": -180},
    "forest_min": FOREST_MIN,
    "vars": meta_vars,
    "countries": names,
    "stats": stats,
}
(OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

print(json.dumps({k: v for k, v in stats.items()}, indent=1))
print("top countries by forest area (Mkm2):",
      [(names[i - 1], round(by_country[i] / 1e6, 2)) for i in order[:10] if i > 0])
for f in sorted(OUT.glob("*.png")):
    print(f.name, f.stat().st_size // 1024, "KB")
