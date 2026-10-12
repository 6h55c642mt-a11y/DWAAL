#!/usr/bin/env python3
"""
Dwaal bake-script: zet per stad alle kaartdata klaar in data/<stad>/.

  python bake.py amsterdam            # alles
  python bake.py paris --only base    # alleen grond/water/straten opnieuw

Bronnen: Overture Maps (gebouwen, land, water, groen, straten), 3DBAG LoD2.2 voor
Nederlandse steden, OpenStreetMap via Overpass (plekken, OV, bomen, markten).
Downloads worden bewaard in bake/cache/<stad>/, dus opnieuw draaien gaat snel.
"""
from __future__ import annotations
import argparse, gzip, json, math, re, struct, sys, time, random, zlib, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# certificaten: de Python van python.org op macOS kent ze niet standaard
import os
try:
    import certifi
    os.environ.setdefault('SSL_CERT_FILE', certifi.where()); os.environ.setdefault('REQUESTS_CA_BUNDLE', certifi.where())
except ImportError:
    pass

import numpy as np
import shapely
from shapely.geometry import Point, Polygon, MultiPolygon, LineString, MultiLineString, box
from shapely.ops import unary_union
from shapely.geometry.polygon import orient
import mapbox_earcut as earcut

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TILE = 500.0          # tegelgrootte in meters
PAD = 50.0            # kwantisatie-marge rond een tegel (gebouwen over de rand)
DEG = math.pi / 180

def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)

# ---------------------------------------------------------------- stadsinstellingen
def read_city(cid: str) -> dict:
    src = (ROOT / 'cities' / f'{cid}.js').read_text(encoding='utf-8')
    m = re.search(r"center:\s*\{\s*lat:\s*([-\d.]+),\s*lon:\s*([-\d.]+)\s*\},\s*radius:\s*(\d+)", src)
    if not m: sys.exit(f'Kon center/radius niet vinden in cities/{cid}.js')
    b = re.search(r"buildings:\s*'(\w+)'", src)
    dh = re.search(r"defaultHeight:\s*([\d.]+)", src)
    ox = re.search(r"osmExtract:\s*'([^']+)'", src)
    return dict(osm=ox[1] if ox else None, id=cid, lat=float(m[1]), lon=float(m[2]), R=float(m[3]), buildings=(b[1] if b else 'overture'), defaultHeight=float(dh[1]) if dh else 12.0)

# ---------------------------------------------------------------- coördinaten (gelijk aan de engine)
WA = 6378137.0; WF = 1 / 298.257223563; WE2 = WF * (2 - WF)
class Proj:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.O = tuple(float(v) for v in self._ecef(np.float64(lat0), np.float64(lon0)))
        self.SP, self.CP, self.SL, self.CL = math.sin(lat0 * DEG), math.cos(lat0 * DEG), math.sin(lon0 * DEG), math.cos(lon0 * DEG)
    @staticmethod
    def _ecef(lat, lon):
        p, l = lat * DEG, lon * DEG; s = np.sin(p); N = WA / np.sqrt(1 - WE2 * s * s)
        return N * np.cos(p) * np.cos(l), N * np.cos(p) * np.sin(l), N * (1 - WE2) * s
    def local(self, lon, lat):
        """lon/lat -> engine (x = oost, z = zuid) in meters"""
        X, Y, Z = self._ecef(np.asarray(lat, float), np.asarray(lon, float))
        dx, dy, dz = X - self.O[0], Y - self.O[1], Z - self.O[2]
        e = -self.SL * dx + self.CL * dy
        n = -self.SP * self.CL * dx - self.SP * self.SL * dy + self.CP * dz
        return e, -n
    def geom(self, g):
        def f(c):
            x, z = self.local(c[:, 0], c[:, 1]); return np.column_stack([x, z])
        return shapely.transform(g, f)
    def bbox(self, R):
        d = R + 80
        return (self.lon0 - d / (111320 * self.CP), self.lat0 - d / 111250, self.lon0 + d / (111320 * self.CP), self.lat0 + d / 111250)

# RD New -> WGS84 (zelfde benadering als eerder in de app, ~1 m)
_K = [(0,1,3235.65389),(2,0,-32.58297),(0,2,-0.24750),(2,1,-0.84978),(0,3,-0.06550),(2,2,-0.01709),(1,0,-0.00738),(4,0,0.00530),(2,3,-0.00039),(4,1,0.00033),(1,1,-0.00012)]
_L = [(1,0,5260.52916),(1,1,105.94684),(1,2,2.45656),(3,0,-0.81885),(1,3,0.05594),(3,1,-0.05607),(0,1,0.01199),(3,2,-0.00256),(1,4,0.00128),(0,2,0.00022),(2,0,-0.00022),(5,0,0.00026)]
_R = [(0,1,190094.945),(1,1,-11832.228),(2,1,-114.221),(0,3,-32.391),(1,0,-0.705),(3,1,-2.340),(1,3,-0.608),(0,2,-0.008),(2,3,0.148)]
_S = [(1,0,309056.544),(0,2,3638.893),(2,0,73.077),(1,2,-157.984),(3,0,59.788),(0,1,0.433),(2,2,-6.439),(1,1,-0.032),(0,4,0.092),(1,4,-0.054)]
def rd2wgs(x, y):
    dx, dy = (np.asarray(x) - 155000) * 1e-5, (np.asarray(y) - 463000) * 1e-5
    lat = 52.15517440 + sum(c * dx ** p * dy ** q for p, q, c in _K) / 3600
    lon = 5.38720621 + sum(c * dx ** p * dy ** q for p, q, c in _L) / 3600
    return lat, lon
def wgs2rd(lat, lon):
    dp, dl = 0.36 * (lat - 52.15517440), 0.36 * (lon - 5.38720621)
    return 155000 + sum(c * dp ** p * dl ** q for p, q, c in _R), 463000 + sum(c * dp ** p * dl ** q for p, q, c in _S)

# ---------------------------------------------------------------- downloads
UA = {'User-Agent': 'dwaal-bake/1.0 (city guide prototype)'}
def http(url, data=None, timeout=300):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()

OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
def overpass(q, cache: Path, required=False, attempts=3, deadline=240):
    """Overpass-vraag met harde tijdslimiet per poging. Bij falen: None (tenzij required)."""
    import concurrent.futures as cf
    if cache.exists(): return json.loads(gzip.decompress(cache.read_bytes()))
    last = None
    for attempt in range(attempts):
        ep = OVERPASS[attempt % len(OVERPASS)]
        log(f'  Overpass ({ep.split("/")[2]}) …')
        ex = cf.ThreadPoolExecutor(max_workers=1)
        fut = ex.submit(http, ep, urllib.parse.urlencode({'data': q}).encode(), 60)
        try:
            j = json.loads(fut.result(timeout=deadline))
            if 'elements' not in j: raise RuntimeError(j.get('remark', 'leeg antwoord'))
            if j.get('remark') and not j['elements']: raise RuntimeError(j['remark'])
            cache.write_bytes(gzip.compress(json.dumps(j).encode())); ex.shutdown(wait=False); return j
        except Exception as e:
            last = e if str(e) else 'tijdslimiet bereikt'; ex.shutdown(wait=False, cancel_futures=True)
            log(f'  mislukt: {last}'); time.sleep(10)
    if required: raise RuntimeError(f'Overpass bleef mislukken: {last}')
    log('  overgeslagen (OpenStreetMap niet bereikbaar); draai dit onderdeel later opnieuw'); return None

def overture(kind: str, bbox, cache: Path):
    """Overture-tabel (pyarrow) voor één type binnen de bbox, met cache."""
    import pyarrow.parquet as pq
    f = cache / f'overture_{kind}.parquet'
    if f.exists(): return pq.read_table(f)
    from overturemaps import core
    last = None
    for attempt in range(5):
        try:
            log(f'  Overture {kind} downloaden …' + (f' (poging {attempt + 1})' if attempt else ''))
            try: rdr = core.record_batch_reader(kind, bbox, connect_timeout=30, request_timeout=180)
            except TypeError: rdr = core.record_batch_reader(kind, bbox)   # oudere versie zonder time-outs
            if rdr is None: return None
            t = rdr.read_all(); pq.write_table(t, f); log(f'  {kind}: {t.num_rows} records')
            return t
        except Exception as e:
            last = e; wait = 15 * (attempt + 1)
            log(f'  verbinding met Overture mislukt ({str(e)[:120]}); opnieuw over {wait} s'); time.sleep(wait)
    raise RuntimeError(f'Overture {kind} bleef mislukken: {last}')

def col(t, name):
    return t.column(name).to_pylist() if t is not None and name in t.column_names else [None] * (t.num_rows if t is not None else 0)

def geoms(t):
    if t is None or t.num_rows == 0: return np.array([], dtype=object)
    return shapely.from_wkb(np.asarray(t.column('geometry').to_pylist(), dtype=object))

# ---------------------------------------------------------------- meshes
def polys_of(g):
    if g is None or g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    if hasattr(g, 'geoms'): return [p for x in g.geoms for p in polys_of(x)]
    return []

class MeshBuf:
    def __init__(self): self.v = []; self.i = []; self.ids = []; self.n = 0
    def add(self, verts, tris, bid):
        base = self.n; self.v.extend(verts); self.ids.extend([bid] * len(verts)); self.i.extend(int(t) + base for t in tris); self.n += len(verts)

def extrude(poly: Polygon, h: float, minh: float, buf: MeshBuf, bid: int):
    poly = orient(poly, 1.0)
    rings = [list(poly.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings: return
    y0 = minh if minh > 0 else -1.5
    flat = [p for r in rings for p in r]; n = len(flat)
    verts = [(x, y0, z) for x, z in flat] + [(x, h, z) for x, z in flat]
    tris = []; off = 0
    for r in rings:
        m = len(r)
        for k in range(m):
            a, b = off + k, off + (k + 1) % m
            tris += [a, b, n + b, a, n + b, n + a]
        off += m
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    try:
        roof = earcut.triangulate_float64(np.asarray(flat, dtype=np.float64), ends)
        tris += [n + int(t) for t in roof]
    except Exception: pass
    buf.add(verts, tris, bid)

def tri_surface(ring3d):
    """vlakke 3D-veelhoek (met gaten) triangulieren via projectie op het grootste vlak"""
    pts = np.asarray([p for r in ring3d for p in r], dtype=np.float64)
    if len(pts) < 3: return pts, []
    o = ring3d[0]; nrm = np.zeros(3)
    for k in range(len(o)):
        a, b = np.asarray(o[k]), np.asarray(o[(k + 1) % len(o)])
        nrm += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    ax = int(np.argmax(np.abs(nrm))); keep = [i for i in range(3) if i != ax]
    ends = np.cumsum([len(r) for r in ring3d]).astype(np.uint32)
    try: t = earcut.triangulate_float64(pts[:, keep], ends)
    except Exception: t = []
    return pts, list(t)

# ---------------------------------------------------------------- gebouwen
class B:
    __slots__ = ('id', 'h', 'yr', 'lv', 'name', 'arch', 'foot', 'parts', 'cx', 'cz')
    def __init__(self, **k):
        for s in self.__slots__: setattr(self, s, k.get(s))

def num(v):
    try: return float(v) if v is not None else None
    except Exception: return None

def buildings_overture(cfg, proj, cache):
    R = cfg['R']; bbox = proj.bbox(R)
    tb = overture('building', bbox, cache); tp = overture('building_part', bbox, cache)
    out = []; disc = Point(0, 0).buffer(R - 4)
    parts_of = {}
    if tp is not None and tp.num_rows:
        for g, bid, h, mh, nf, mf in zip(geoms(tp), col(tp, 'building_id'), col(tp, 'height'), col(tp, 'min_height'), col(tp, 'num_floors'), col(tp, 'min_floor')):
            if g is None: continue
            parts_of.setdefault(bid, []).append((g, num(h), num(mh), num(nf), num(mf)))
    gs = geoms(tb)
    for g, bid, h, mh, nf, mf, names, yr in zip(gs, col(tb, 'id'), col(tb, 'height'), col(tb, 'min_height'), col(tb, 'num_floors'), col(tb, 'min_floor'), col(tb, 'names'), col(tb, 'year_built') if 'year_built' in tb.column_names else [None] * tb.num_rows):
        if g is None: continue
        lg = proj.geom(g)
        c = lg.centroid
        if not disc.contains(c): continue
        def height(h, nf, fallback):
            h = num(h); nf = num(nf)
            if h and h > 0: return h
            if nf and nf > 0: return nf * 3.2 + 1.0
            return fallback
        rnd = (zlib.crc32(str(bid).encode()) % 1000) / 1000.0
        hh = height(h, nf, cfg['defaultHeight'] * (0.8 + 0.45 * rnd))
        minh = num(mh) or ((num(mf) or 0) * 3.2)
        parts = []
        for pg, ph, pmh, pnf, pmf in parts_of.get(bid, []):
            parts.append((proj.geom(pg), height(ph, pnf, hh), num(pmh) or ((num(pmf) or 0) * 3.2)))
        if not parts: parts = [(lg, hh, minh)]
        nm = names.get('primary') if isinstance(names, dict) else None
        out.append(B(id=bid, h=round(max(p[1] for p in parts), 1), yr=int(yr) if yr else None, lv=int(num(nf)) if num(nf) else None, name=nm, arch=None, foot=lg, parts=parts, cx=c.x, cz=c.y))
    log(f'  {len(out)} gebouwen (Overture)')
    return out

def buildings_3dbag(cfg, proj, cache):
    """3DBAG LoD2.2 uit de GeoPackage-tegels. Valt terug op Overture bij problemen."""
    import pyogrio
    R = cfg['R']; lon0, lat0, lon1, lat1 = proj.bbox(R)
    rx0, ry0 = wgs2rd(lat0, lon0); rx1, ry1 = wgs2rd(lat1, lon1)
    rbb = (min(rx0, rx1), min(ry0, ry1), max(rx0, rx1), max(ry0, ry1))
    ver = 'v20250903'
    idx = None
    for url in [f'https://data.3dbag.nl/{ver}/tile_index.fgb', 'https://data.3dbag.nl/latest/tile_index.fgb']:
        try:
            idx = pyogrio.raw.read('/vsicurl/' + url, bbox=rbb); log(f'  3DBAG tegelindex: {url}'); break
        except Exception as e: log(f'  tegelindex niet via {url}: {e}')
    if idx is None: raise RuntimeError('3DBAG tegelindex niet bereikbaar')
    meta, fields = idx[0], idx[-1]
    names = list(meta['fields'])
    log(f'  velden tegelindex: {names}')
    isurl = lambda v: isinstance(v, str) and v.startswith('http') and v.split('?')[0].endswith(('.gpkg', '.gpkg.zip'))
    dl = next((i for i, n in enumerate(names) if fields[i] is not None and len(fields[i]) and isurl(fields[i][0]) and 'gpkg' in str(fields[i][0])), None)
    tid = next((i for i, n in enumerate(names) if n.lower() in ('tile_id', 'id', 'tile')), None)
    urls = []
    for k in range(len(fields[0]) if fields else 0):
        if dl is not None: urls.append(fields[dl][k])
        elif tid is not None:
            t = str(fields[tid][k]); urls.append(f'https://data.3dbag.nl/{ver}/tiles/{t.replace("-", "/")}/{t}.gpkg')
    log(f'  {len(urls)} 3DBAG-tegels')
    disc = Point(0, 0).buffer(R - 4); out = []; seen = set()
    for n, url in enumerate(urls):
        f = cache / ('3dbag_' + url.split('?')[0].rstrip('/').split('/')[-1].replace('.zip', ''))
        if not f.exists():
            log(f'  download {n + 1}/{len(urls)} {f.name}'); data = http(url, timeout=600)
            if url.split('?')[0].endswith('.zip'):
                import zipfile, io
                with zipfile.ZipFile(io.BytesIO(data)) as z: data = z.read(next(n_ for n_ in z.namelist() if n_.endswith('.gpkg')))
            f.write_bytes(data)
        layers = [l[0] for l in pyogrio.list_layers(f)]
        l3 = next((l for l in layers if 'lod22_3d' in l), None) or next((l for l in layers if 'lod22' in l), None)
        lp = next((l for l in layers if l == 'pand'), None)
        if not l3: raise RuntimeError(f'geen LoD2.2-laag in {f.name}: {layers}')
        attrs = {}
        if lp:
            m2, _, g2, fd2 = pyogrio.raw.read(f, layer=lp, bbox=rbb)
            nm2 = list(m2['fields'])
            def fcol(names_try):
                i = next((nm2.index(x) for x in names_try if x in nm2), None)
                return fd2[i] if i is not None else [None] * len(g2)
            ids2 = fcol(['identificatie']); yrs = fcol(['oorspronkelijkbouwjaar', 'oorspronkelijk_bouwjaar']); hs = fcol(['b3_h_dak_max', 'b3_h_dak_70p']); gr = fcol(['b3_h_maaiveld'])
            for g, i_, y_, h_, m_ in zip(shapely.from_wkb(g2), ids2, yrs, hs, gr): attrs[str(i_)] = (g, y_, h_, m_)
        m3, _, g3, fd3 = pyogrio.raw.read(f, layer=l3, bbox=rbb)
        nm3 = list(m3['fields']); ii = nm3.index('identificatie') if 'identificatie' in nm3 else None
        gm = nm3.index('b3_h_maaiveld') if 'b3_h_maaiveld' in nm3 else None
        for k, g in enumerate(shapely.from_wkb(g3)):
            if g is None: continue
            bid = str(fd3[ii][k]) if ii is not None else f'{f.name}:{k}'
            if bid in seen: continue
            a = attrs.get(bid)
            ground = num(fd3[gm][k]) if gm is not None else (num(a[3]) if a else None)
            surf = []
            for p in polys_of(g):
                rings = [list(p.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in p.interiors]
                rings = [r for r in rings if len(r) >= 3]
                if not rings: continue
                local = []
                for r in rings:
                    arr = np.asarray(r, float); la, lo = rd2wgs(arr[:, 0], arr[:, 1]); x, z = proj.local(lo, la)
                    local.append(list(zip(x, arr[:, 2], z)))
                surf.append(local)
            if not surf: continue
            allp = np.asarray([q for s in surf for r in s for q in r])
            gz = ground if ground is not None else float(allp[:, 1].min())
            foot = proj.geom(shapely.transform(a[0], lambda c: np.column_stack(rd2wgs(c[:, 0], c[:, 1])[::-1]))) if a and a[0] is not None else shapely.convex_hull(shapely.MultiPoint(allp[:, [0, 2]]))
            c = foot.centroid
            if not disc.contains(c): continue
            seen.add(bid)
            out.append(B(id=bid.replace('NL.IMBAG.Pand.', ''), h=round(float(allp[:, 1].max() - gz), 1), yr=int(a[1]) if a and a[1] else None, lv=None, name=None, arch=None, foot=foot, parts=[('surf', surf, gz)], cx=c.x, cz=c.y))
        log(f'  {len(out)} gebouwen tot nu toe')
    return out

# ---------------------------------------------------------------- tegels schrijven (formaat 'DWT1')
def pack_tile(tx, tz, verts, idx, ids):
    nv, ni = len(verts), len(idx)
    x0, z0 = tx * TILE - PAD, tz * TILE - PAD
    v = np.asarray(verts, dtype=np.float64).reshape(-1, 3) if nv else np.zeros((0, 3))
    q = np.empty((nv, 3), dtype=np.uint16)
    q[:, 0] = np.clip(np.round((v[:, 0] - x0) * 100), 0, 65535)
    q[:, 1] = np.clip(np.round((v[:, 1] + 20) * 100), 0, 65535)
    q[:, 2] = np.clip(np.round((v[:, 2] - z0) * 100), 0, 65535)
    it = 2 if nv < 65536 else 4
    out = bytearray(struct.pack('<iiIIBBH', tx, tz, nv, ni, it, 1 if ids is not None else 0, 0))
    def pad4():
        while len(out) % 4: out.append(0)
    out += q.tobytes(); pad4()
    if ids is not None: out += np.asarray(ids, dtype=np.uint16).tobytes(); pad4()
    out += np.asarray(idx, dtype=np.uint16 if it == 2 else np.uint32).tobytes(); pad4()
    return bytes(out)

def write_file(tiles_bytes: list, path: Path):
    path.write_bytes(gzip.compress(b'DWT1' + struct.pack('<I', len(tiles_bytes)) + b''.join(tiles_bytes), 6))

def mesh_building(b: B, buf: MeshBuf, bid: int):
    for part in b.parts:
        if part[0] == 'surf':
            _, surf, gz = part; base = buf.n; vs = []; tris = []
            for s in surf:
                pts, t = tri_surface(s)
                off = len(vs); vs += [(p[0], p[1] - gz, p[2]) for p in pts]; tris += [off + int(i) for i in t]
            buf.add(vs, tris, bid)
        else:
            g, h, minh = part
            for p in polys_of(g.simplify(0.15)):
                if p.area > 1: extrude(p, h, minh, buf, bid)

def lo_blocks(bs: list[B]):
    """lichte versie: lage gebouwen samengevoegd tot bouwblokken per hoogteklasse, torens los"""
    buf = MeshBuf(); classes = [(0, 12), (12, 24), (24, 45)]
    for lo, hi in classes:
        grp = [b for b in bs if lo <= b.h < hi]
        if not grp: continue
        u = unary_union([b.foot.buffer(0.8, join_style=2) for b in grp]).buffer(-0.8, join_style=2)
        hh = float(np.mean([b.h for b in grp]))
        for p in polys_of(u.simplify(1.5)):
            if p.area >= 40: extrude(p, hh, 0, buf, 0)
    for b in bs:
        if b.h >= 45:
            for p in polys_of(b.foot.simplify(1.0)):
                if p.area > 4: extrude(p, b.h, 0, buf, 0)
    return buf

def bake_buildings(cfg, proj, cache, out: Path):
    try:
        bs = buildings_3dbag(cfg, proj, cache) if cfg['buildings'] == '3dbag' else buildings_overture(cfg, proj, cache)
    except Exception as e:
        if cfg['buildings'] != '3dbag': raise
        log(f'  3DBAG lukte niet ({e}); terugval op Overture'); bs = buildings_overture(cfg, proj, cache)
    tiles: dict[tuple, list] = {}
    for b in bs: tiles.setdefault((math.floor(b.cx / TILE), math.floor(b.cz / TILE)), []).append(b)
    (out / 'hi').mkdir(parents=True, exist_ok=True)
    for f in (out / 'hi').glob('*'): f.unlink()
    lo_parts, hi_keys = [], {}
    for n, ((tx, tz), group) in enumerate(sorted(tiles.items())):
        lb = lo_blocks(group)
        if lb.n: lo_parts.append(pack_tile(tx, tz, lb.v, lb.i, None))
        hb = MeshBuf(); attrs = []
        for k, b in enumerate(group[:65000]):
            mesh_building(b, hb, k)
            ring = []
            ext = polys_of(b.foot)
            if ext:
                for x, z in list(max(ext, key=lambda p: p.area).simplify(0.3).exterior.coords)[:-1]:
                    ring += [round((x - tx * TILE) * 10), round((z - tz * TILE) * 10)]
            attrs.append([b.id, b.h, b.yr, b.lv, b.name, b.arch, ring])
        if hb.n:
            key = f'{tx}_{tz}'; write_file([pack_tile(tx, tz, hb.v, hb.i, hb.ids)], out / 'hi' / f'{key}.bin.gz')
            (out / 'hi' / f'{key}.json.gz').write_bytes(gzip.compress(json.dumps({'b': attrs}, separators=(',', ':')).encode(), 9))
            hi_keys[key] = len(group)
        if n % 25 == 0: log(f'  tegels {n + 1}/{len(tiles)}')
    write_file(lo_parts, out / 'lo.bin.gz')
    log(f'  lo.bin.gz: {(out / "lo.bin.gz").stat().st_size / 1e6:.1f} MB, {len(hi_keys)} detailtegels')
    return hi_keys, len(bs)


# ---------------------------------------------------------------- OpenStreetMap uit een regio-extract (Geofabrik)
# Geen Overpass meer: één download per regio, lokaal gefilterd met osmium. Betrouwbaar en snel.
STOP_KEYS = lambda t: t.get('railway') in ('tram_stop', 'station', 'subway_entrance') or t.get('highway') == 'bus_stop' or t.get('station') == 'subway' or t.get('amenity') == 'ferry_terminal'
def osm_data(cfg, proj, cache: Path):
    f = cache / 'osm_city.json.gz'
    if f.exists(): return json.loads(gzip.decompress(f.read_bytes()))
    if not cfg.get('osm'): log('  geen osmExtract ingesteld in het stadsbestand; OSM-onderdelen overgeslagen'); return None
    import osmium, subprocess, shutil
    big = cache / ('region_' + cfg['osm'].rstrip('/').split('/')[-1])
    if not big.exists():
        log(f'  OSM-extract downloaden: {cfg["osm"]}')
        req = urllib.request.Request(cfg['osm'], headers=UA)
        with urllib.request.urlopen(req, timeout=1800) as r, open(str(big) + '.part', 'wb') as o: shutil.copyfileobj(r, o, 1 << 20)
        Path(str(big) + '.part').rename(big)
    log(f'  regio: {big.stat().st_size / 1e6:.0f} MB')
    lon0, lat0, lon1, lat1 = proj.bbox(cfg['R'])
    city = cache / 'osm_city.osm.pbf'
    if shutil.which('osmium'):
        subprocess.run(['osmium', 'extract', '-b', f'{lon0},{lat0},{lon1},{lat1}', '-s', 'smart', '--overwrite', '-o', str(city), str(big)], check=True)
        log(f'  uitsnede stad: {city.stat().st_size / 1e6:.0f} MB')
    else: city = big
    inb = lambda lat, lon: lat0 <= lat <= lat1 and lon0 <= lon <= lon1
    # pas 1: OV-relaties en hun leden
    rels, want_w, want_n = [], set(), set()
    for o in osmium.FileProcessor(str(city), osmium.osm.RELATION):
        t = dict(o.tags)
        if t.get('type') != 'route' or t.get('route') not in ('tram', 'subway', 'ferry', 'light_rail', 'bus'): continue
        mem = [{'type': {'n': 'node', 'w': 'way', 'r': 'relation'}[m.type], 'ref': m.ref, 'role': m.role} for m in o.members]
        for m in mem:
            if m['type'] == 'way' and t['route'] != 'bus': want_w.add(m['ref'])
            if m['type'] == 'node': want_n.add(m['ref'])
        rels.append({'type': 'relation', 'id': o.id, 'tags': t, 'members': mem})
    # pas 2: knopen en wegen met coördinaten
    trees, stops, markets, wgeo, ncoord = [], [], [], {}, {}
    for o in osmium.FileProcessor(str(city)).with_locations():
        if o.is_node():
            if not o.location.valid(): continue
            lat, lon = o.location.lat, o.location.lon
            if o.id in want_n: ncoord[o.id] = (round(lat, 6), round(lon, 6))
            if not inb(lat, lon) or not len(o.tags): continue
            t = dict(o.tags)
            if t.get('natural') == 'tree': trees.append({'type': 'node', 'lat': lat, 'lon': lon})
            elif STOP_KEYS(t): stops.append({'type': 'node', 'id': o.id, 'lat': round(lat, 6), 'lon': round(lon, 6), 'tags': t})
        elif o.is_way():
            t = dict(o.tags); isw = o.id in want_w; mk = t.get('amenity') == 'marketplace'; st = STOP_KEYS(t)
            if not (isw or mk or st): continue
            pts = [{'lat': round(n.lat, 6), 'lon': round(n.lon, 6)} for n in o.nodes if n.location.valid()]
            if len(pts) < 2: continue
            if isw: wgeo[o.id] = pts
            if mk and len(pts) > 3: markets.append({'type': 'way', 'id': o.id, 'tags': t, 'geometry': pts})
            if st:
                c = {'lat': round(sum(p['lat'] for p in pts) / len(pts), 6), 'lon': round(sum(p['lon'] for p in pts) / len(pts), 6)}
                if inb(c['lat'], c['lon']): stops.append({'type': 'way', 'id': o.id, 'center': c, 'tags': t})
    for r in rels:
        for m in r['members']:
            if m['type'] == 'way' and m['ref'] in wgeo: m['geometry'] = wgeo[m['ref']]
            if m['type'] == 'node' and m['ref'] in ncoord: m['lat'], m['lon'] = ncoord[m['ref']]
    rels = [r for r in rels if any('geometry' in m or 'lat' in m for m in r['members'])]
    d = {'trees': trees, 'stops': stops, 'markets': markets, 'routes': rels}
    f.write_bytes(gzip.compress(json.dumps(d, separators=(',', ':')).encode()))
    log(f'  OSM: {len(trees)} bomen, {len(stops)} haltes, {len(markets)} markten, {len(rels)} OV-lijnen')
    return d

# ---------------------------------------------------------------- grond, water, groen, straten, bomen
def flat(coords, nd=1):
    return [round(v, nd) for xz in coords for v in xz]

def bake_base(cfg, proj, cache, out: Path):
    R = cfg['R']; bbox = proj.bbox(R); disc = Point(0, 0).buffer(R, 256); square = box(-R - 60, -R - 60, R + 60, R + 60)
    tl = overture('land', bbox, cache); tw = overture('water', bbox, cache)
    land_g = [proj.geom(g) for g, st in zip(geoms(tl), col(tl, 'subtype')) if g is not None and g.geom_type in ('Polygon', 'MultiPolygon') and st not in ('reef', 'shoal')]
    land = unary_union(land_g).intersection(square) if land_g else square
    if land.is_empty or land.area < square.area * 0.05: land = square
    water_poly = [proj.geom(g) for g in geoms(tw) if g is not None and g.geom_type in ('Polygon', 'MultiPolygon')]
    water = unary_union(water_poly).intersection(square) if water_poly else Polygon()
    groundg = land.difference(water).buffer(0)
    ground = groundg.intersection(disc).simplify(0.6)
    out_ground = []
    for p in polys_of(ground):
        if p.area < 20: continue
        out_ground.append({'o': flat(p.exterior.coords[:-1]), 'h': [flat(r.coords[:-1]) for r in p.interiors if Polygon(r).area > 8]})
    quays = []
    for l in (getattr(groundg.boundary.intersection(disc.buffer(-3)), 'geoms', None) or [groundg.boundary.intersection(disc.buffer(-3))]):
        if isinstance(l, LineString) and l.length > 2: quays.append(flat(l.simplify(0.6).coords))
    rivers = []
    for g, st in zip(geoms(tw), col(tw, 'subtype')):
        if g is not None and g.geom_type in ('LineString', 'MultiLineString') and st in ('canal', 'river'):
            lg = proj.geom(g).intersection(disc.buffer(-20))
            for l in (getattr(lg, 'geoms', None) or [lg]):
                if isinstance(l, LineString) and l.length > 100: rivers.append(flat(l.coords))
    log(f'  grond: {len(out_ground)} vlakken, {len(quays)} kades, {len(rivers)} rivierlijnen')
    tu = overture('land_use', bbox, cache); parks = []
    pk = [proj.geom(g) for g, st, cl in zip(geoms(tu), col(tu, 'subtype'), col(tu, 'class')) if g is not None and g.geom_type in ('Polygon', 'MultiPolygon') and (st in ('park', 'recreation') or cl in ('park', 'garden', 'village_green', 'grass'))]
    if pk:
        for p in polys_of(unary_union(pk).intersection(disc).difference(water).simplify(0.8)):
            if p.area > 60: parks.append({'o': flat(p.exterior.coords[:-1])})
    ts = overture('segment', bbox, cache); streets = []
    CL = {'motorway': 'primary', 'trunk': 'primary', 'primary': 'primary', 'secondary': 'secondary', 'tertiary': 'tertiary', 'residential': 'residential', 'living_street': 'living_street', 'unclassified': 'unclassified', 'pedestrian': 'pedestrian', 'service': 'service'}
    flags = col(ts, 'road_flags') if ts is not None and 'road_flags' in ts.column_names else [None] * (ts.num_rows if ts is not None else 0)
    for g, st, cl, fl in zip(geoms(ts), col(ts, 'subtype'), col(ts, 'class'), flags):
        if g is None or st != 'road' or cl not in CL: continue
        lg = proj.geom(g).intersection(disc)
        for l in (getattr(lg, 'geoms', None) or [lg]):
            if isinstance(l, LineString) and l.length > 1:
                streets.append({'c': CL[cl], 'b': 1 if fl and 'is_bridge' in json.dumps(fl) else 0, 'p': flat(l.simplify(0.4).coords)})
    log(f'  {len(parks)} parken, {len(streets)} straatdelen')
    lat0, lon0, lat1, lon1 = bbox[1], bbox[0], bbox[3], bbox[2]; ob = f'{lat0:.5f},{lon0:.5f},{lat1:.5f},{lon1:.5f}'
    od = osm_data(cfg, proj, cache) or {}
    tj = {'elements': od.get('trees', [])}
    pts = []
    for el in tj.get('elements', []):
        x, z = proj.local(el['lon'], el['lat']); x, z = float(x), float(z)
        if x * x + z * z < (R - 4) ** 2: pts.append((round(x, 1), round(z, 1)))
    random.Random(1).shuffle(pts); pts = pts[:60000]
    mj = {'elements': od.get('markets', [])}
    markets = []
    for el in mj.get('elements', []):
        if el.get('type') == 'way' and el.get('geometry'):
            xs, zs = proj.local([p['lon'] for p in el['geometry']], [p['lat'] for p in el['geometry']])
            if len(xs) > 3: markets.append({'o': flat(zip(xs.tolist(), zs.tolist()))})
    base = {'ground': out_ground, 'quays': quays, 'parks': parks, 'markets': markets, 'streets': streets, 'rivers': rivers, 'trees': [v for p in pts for v in p]}
    (out / 'base.json.gz').write_bytes(gzip.compress(json.dumps(base, separators=(',', ':')).encode(), 9))
    log(f'  base.json.gz: {(out / "base.json.gz").stat().st_size / 1e6:.1f} MB ({len(pts)} bomen)')

# ---------------------------------------------------------------- plekken en OV (OpenStreetMap)
KEEP = {'name', 'amenity', 'tourism', 'historic', 'leisure', 'shop', 'railway', 'station', 'highway', 'public_transport', 'opening_hours', 'website', 'contact:website',
        'phone', 'contact:phone', 'wheelchair', 'cuisine', 'addr:street', 'addr:housenumber', 'wikipedia', 'route_ref', 'operator', 'breakfast', 'lunch'}
def slim(el):
    o = {'type': el['type'], 'id': el['id'], 'tags': {k: v for k, v in (el.get('tags') or {}).items() if k in KEEP}}
    if 'lat' in el: o['lat'], o['lon'] = round(el['lat'], 6), round(el['lon'], 6)
    if 'center' in el: o['center'] = {'lat': round(el['center']['lat'], 6), 'lon': round(el['center']['lon'], 6)}
    return o

# Overture-categorie -> OSM-achtige tags, zodat de app ze in dezelfde lagen indeelt
def place_tags(cat: str):
    c = (cat or '').lower()
    has = lambda *w: any(x in c for x in w)
    if not c: return None
    if has('parking', 'barber', 'bank', 'dentist', 'doctor', 'hospital', 'pharmacy', 'school', 'office', 'insurance', 'lawyer', 'real_estate', 'automotive', 'car_', 'hotel', 'hostel', 'apartment'): return None
    if has('museum', 'art_gallery'): return {'tourism': 'museum'}
    if has('opera', 'theat', 'concert', 'music_venue', 'jazz', 'comedy_club', 'performing_arts'): return {'amenity': 'theatre'}
    if has('cinema', 'movie'): return {'amenity': 'cinema'}
    if has('ice_cream', 'gelato', 'frozen_yogurt', 'dessert'): return {'amenity': 'ice_cream'}
    if has('fast_food', 'burger', 'sandwich', 'falafel', 'kebab', 'hot_dog', 'food_truck'): return {'amenity': 'fast_food', 'cuisine': c}
    if has('breakfast', 'brunch', 'bakery', 'patisserie', 'boulangerie', 'bagel'): return {'amenity': 'cafe', 'cuisine': 'breakfast;' + c}
    if has('coffee', 'cafe', 'tea_room', 'tea_house'): return {'amenity': 'cafe', 'cuisine': c}
    if has('cocktail', 'wine_bar', 'beer_bar', 'pub', 'brewery', 'sports_bar', 'dive_bar', 'tavern', 'speakeasy') or c == 'bar' or c.endswith('_bar'): return {'amenity': 'pub' if 'pub' in c else 'bar'}
    if has('restaurant', 'bistro', 'brasserie', 'steakhouse', 'pizzeria', 'trattoria', 'diner', 'eatery', 'sushi', 'tapas'): return {'amenity': 'restaurant', 'cuisine': c.replace('_restaurant', '')}
    if has('farmers_market', 'flea_market', 'market'): return {'amenity': 'marketplace'}
    if has('department_store', 'shopping_mall'): return {'shop': 'department_store'}
    if has('botanical_garden', 'park', 'garden') and not has('amusement', 'water_park', 'parking'): return {'leisure': 'garden' if 'garden' in c else 'park'}
    if has('landmark', 'monument', 'memorial', 'historical', 'castle', 'palace', 'fort'): return {'historic': 'monument'}
    if has('tourist_attraction', 'viewpoint', 'observation', 'scenic'): return {'tourism': 'attraction' if 'attraction' in c else 'viewpoint'}
    return None

def bake_places(cfg, proj, cache, out: Path):
    R = cfg['R']; bbox = proj.bbox(R)
    tp = overture('place', bbox, cache); els = []; seen = set()
    log(f'  kolommen: {", ".join(tp.column_names) if tp is not None else "-"}')
    def catname(i):
        for c in ('categories', 'basic_category', 'taxonomy'):
            if tp is not None and c in tp.column_names:
                v = tp.column(c)[i].as_py()
                if isinstance(v, dict): v = v.get('primary') or v.get('basic_category')
                if isinstance(v, str) and v: return v
        return None
    cats = [catname(i) for i in range(tp.num_rows)] if tp is not None else []
    from collections import Counter; unmapped = Counter(); skipped = Counter()
    names = col(tp, 'names'); conf = col(tp, 'confidence'); webs = col(tp, 'websites'); phones = col(tp, 'phones'); addrs = col(tp, 'addresses'); ids = col(tp, 'id')
    for g, cat, nm, cf, web, ph, ad, pid in zip(geoms(tp), cats, names, conf, webs, phones, addrs, ids):
        if g is None: skipped['geen geometrie'] += 1; continue
        if cf is not None and cf < 0.6: skipped['lage betrouwbaarheid'] += 1; continue
        name = nm.get('primary') if isinstance(nm, dict) else None
        if not name: skipped['geen naam'] += 1; continue
        tags = place_tags(cat)
        if not tags: unmapped[cat] += 1; continue
        if g.geom_type != 'Point': g = g.centroid
        x, z = proj.local(g.x, g.y)
        if float(x) ** 2 + float(z) ** 2 > R * R: continue
        key = (name.lower(), round(float(x) / 15), round(float(z) / 15))
        if key in seen: continue
        seen.add(key)
        tags['name'] = name
        if web: tags['website'] = web[0]
        if ph: tags['phone'] = ph[0]
        if ad and isinstance(ad[0], dict) and ad[0].get('freeform'): tags['addr:street'] = ad[0]['freeform']
        els.append({'type': 'node', 'id': pid, 'lat': round(g.y, 6), 'lon': round(g.x, 6), 'tags': tags})
    log(f'  {len(els)} plekken uit Overture; overgeslagen: {dict(skipped)}')
    log(f'  meest voorkomende niet-gebruikte categorieën: {unmapped.most_common(25)}')
    lon0, lat0, lon1, lat1 = bbox; ob = f'{lat0:.5f},{lon0:.5f},{lat1:.5f},{lon1:.5f}'
    od = osm_data(cfg, proj, cache) or {}
    els += [slim(e) for e in od.get('stops', [])]; log(f'  {len(od.get("stops", []))} haltes en stations uit OpenStreetMap')
    (out / 'places.json.gz').write_bytes(gzip.compress(json.dumps({'elements': els}, separators=(',', ':')).encode(), 9))
    log(f'  places.json.gz: {len(els)} plekken, {(out / "places.json.gz").stat().st_size / 1e6:.1f} MB')

def bake_transit(cfg, proj, cache, out: Path):
    lon0, lat0, lon1, lat1 = proj.bbox(cfg['R']); ob = f'{lat0:.5f},{lon0:.5f},{lat1:.5f},{lon1:.5f}'
    j = {'elements': (osm_data(cfg, proj, cache) or {}).get('routes', [])}
    keep = {'route', 'ref', 'name', 'colour', 'to', 'from'}
    els = []
    for r in j['elements']:
        if r.get('type') != 'relation': continue
        mem = []
        for m in r.get('members', []):
            mm = {'type': m['type'], 'ref': m['ref'], 'role': m.get('role', '')}
            if 'lat' in m: mm['lat'], mm['lon'] = round(m['lat'], 6), round(m['lon'], 6)
            if m.get('geometry'): mm['geometry'] = [{'lat': round(p['lat'], 6), 'lon': round(p['lon'], 6)} for p in m['geometry'] if p]
            mem.append(mm)
        els.append({'type': 'relation', 'id': r['id'], 'tags': {k: v for k, v in (r.get('tags') or {}).items() if k in keep}, 'members': mem})
    (out / 'transit.json.gz').write_bytes(gzip.compress(json.dumps({'elements': els}, separators=(',', ':')).encode(), 9))
    log(f'  transit.json.gz: {len(els)} lijnen')

# ---------------------------------------------------------------- hoofdprogramma
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('city'); ap.add_argument('--only', default='buildings,base,places,transit')
    a = ap.parse_args(); cfg = read_city(a.city); proj = Proj(cfg['lat'], cfg['lon'])
    cache = HERE / 'cache' / a.city; cache.mkdir(parents=True, exist_ok=True)
    out = ROOT / 'data' / a.city; out.mkdir(parents=True, exist_ok=True)
    mpath = out / 'manifest.json'; man = json.loads(mpath.read_text()) if mpath.exists() else {}
    log(f'{a.city}: straal {cfg["R"]:.0f} m, gebouwen uit {cfg["buildings"]}')
    stages = a.only.split(',')
    if 'buildings' in stages: log('Gebouwen …'); hi, n = bake_buildings(cfg, proj, cache, out); man.update(hi=hi, buildings=n)
    if 'base' in stages: log('Grond, water, groen, straten, bomen …'); bake_base(cfg, proj, cache, out)
    if 'places' in stages: log('Plekken …'); bake_places(cfg, proj, cache, out)
    if 'transit' in stages: log('Openbaar vervoer …'); bake_transit(cfg, proj, cache, out)
    man.update(v=1, city=a.city, center={'lat': cfg['lat'], 'lon': cfg['lon']}, radius=cfg['R'], tile=TILE, lo='lo.bin.gz',
               built=datetime.now(timezone.utc).isoformat(timespec='seconds'), sources=['Overture Maps Foundation', '3DBAG (TU Delft)' if cfg['buildings'] == '3dbag' else None, 'OpenStreetMap-bijdragers'])
    man.setdefault('hi', {})
    mpath.write_text(json.dumps(man, indent=1))
    size = sum(f.stat().st_size for f in out.rglob('*') if f.is_file())
    log(f'Klaar: {out} ({size / 1e6:.1f} MB totaal)')

if __name__ == '__main__':
    main()
