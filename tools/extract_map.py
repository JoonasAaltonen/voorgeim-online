"""Extract the strategic-map node graph from the Figma SVG export.

Run once (or after re-exporting the map) to regenerate `src/data/map.json`:

    python tools/extract_map.py

The Figma export carries no layer names, but it preserves the legend colors
exactly and uses no transforms, so shapes segment cleanly by fill in the native
2246x1684 pixel space:

    #EFE9D8  23 land node regions      #C3CFFA   5 sea node regions
    #B15C84   2 staging circles        #FBFAF4  84 division spots
    #D9D9D9  46 movement-path segs     #2C2C28  28 per-node p1/p2 dividers
    #FF0000  12 chevrons = 4 directional indirect-fire arrows

Model notes:
- The manual's "28 locations ... which can be contested" are the 23 land + 5 sea
  regions. The 2 staging circles are separate nodes: they sit outside every land
  region, and the 28 divider lines match the contested nodes exactly (staging has
  no p1/p2 halves because it is never contested).
- Terrain is currently visual flavor with no rules attached, so it is not
  extracted. The map art conveys it; re-derive from the legend washes if terrain
  rules ever land.
- Sea links are not a separate relation: an edge to a node with `sea: true` is a
  sea link, so there is nothing to keep in sync.
"""

import json
import math
import re
from collections import defaultdict
from pathlib import Path

SVG = Path(__file__).resolve().parents[2] / "Figma exports" / "Strategic map Figma.svg"
OUT = Path(__file__).resolve().parents[1] / "src" / "data" / "map.json"

LAND, SEA, STAGING = "#EFE9D8", "#C3CFFA", "#B15C84"
SPOT, PATH, ARROW, DIVIDER = "#FBFAF4", "#D9D9D9", "#FF0000", "#2C2C28"

EXPECT = {LAND: 23, SEA: 5, STAGING: 2, SPOT: 84, PATH: 46, ARROW: 12, DIVIDER: 28}


# --- SVG path parsing -------------------------------------------------------


def flatten(d, steps=16):
    """Flatten one path's `d` into polygons (absolute M/C/L/H/V/Z only)."""
    flat = re.findall(r"([MCLHVZ])|(-?\d*\.?\d+(?:e-?\d+)?)", d)
    polys, poly = [], []
    cur = start = (0.0, 0.0)
    i = 0

    def nums(k):
        nonlocal i
        out = []
        while len(out) < k:
            out.append(float(flat[i][1]))
            i += 1
        return out

    while i < len(flat):
        cmd = flat[i][0]
        if cmd is None:
            raise ValueError(f"number outside a command in: {d[:40]}")
        i += 1
        while True:
            if cmd == "M":
                if poly:
                    polys.append(poly)
                cur = start = tuple(nums(2))
                poly = [cur]
            elif cmd == "L":
                cur = tuple(nums(2))
                poly.append(cur)
            elif cmd == "H":
                cur = (nums(1)[0], cur[1])
                poly.append(cur)
            elif cmd == "V":
                cur = (cur[0], nums(1)[0])
                poly.append(cur)
            elif cmd == "C":
                x1, y1, x2, y2, x, y = nums(6)
                p0 = cur
                for s in range(1, steps + 1):
                    t = s / steps
                    u = 1 - t
                    poly.append(
                        (
                            u**3 * p0[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x,
                            u**3 * p0[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y,
                        )
                    )
                cur = (x, y)
            elif cmd == "Z":
                if poly:
                    polys.append(poly)
                poly = []
                cur = start
            # An SVG command repeats while bare numbers keep following it.
            if cmd == "Z" or i >= len(flat) or flat[i][0] is not None:
                break
    if poly:
        polys.append(poly)
    return [p for p in polys if len(p) >= 3]


def parse():
    src = SVG.read_text(encoding="utf8")
    shapes = []
    # Attribute order varies (Figma emits fill-rule before d on some paths), so
    # match the element first and pull d/fill out of it independently.
    for attrs in re.findall(r"<path\b([^>]*)>", src):
        d = re.search(r'\sd="([^"]*)"', attrs)
        fill = re.search(r'\sfill="(#[0-9A-Fa-f]{6})"', attrs)
        if d and fill:
            shapes.append({"fill": fill.group(1).upper(), "polys": flatten(d.group(1))})
    return shapes


# --- geometry ---------------------------------------------------------------


def area_centroid(poly):
    a = cx = cy = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    a *= 0.5
    if abs(a) < 1e-9:
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        return 0.0, (sum(xs) / len(xs), sum(ys) / len(ys))
    return a, (cx / (6 * a), cy / (6 * a))


def shape_centroid(shape):
    """Area-weighted centroid across a shape's rings."""
    tot = cx = cy = 0.0
    for poly in shape["polys"]:
        a, (x, y) = area_centroid(poly)
        a = abs(a)
        tot += a
        cx += x * a
        cy += y * a
    return (cx / tot, cy / tot) if tot else shape["polys"][0][0]


def in_poly(pt, poly):
    x, y = pt
    inside = False
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        if (y0 > y) != (y1 > y):
            if x < x0 + (y - y0) / (y1 - y0) * (x1 - x0):
                inside = not inside
    return inside


def in_shape(pt, shape):
    """Even-odd containment across a shape's rings (handles holes)."""
    return sum(in_poly(pt, poly) for poly in shape["polys"]) % 2 == 1


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def long_axis(shape):
    """The two farthest-apart points of a shape — a thin segment's endpoints."""
    pts = [p for poly in shape["polys"] for p in poly]
    best, pair = -1.0, (pts[0], pts[0])
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = dist(pts[i], pts[j])
            if d > best:
                best, pair = d, (pts[i], pts[j])
    return pair


# --- extraction -------------------------------------------------------------


def build_regions(by_fill):
    """The 30 map regions: 28 contested nodes (n01..n28) plus 2 staging areas.

    Ids run top-left to bottom-right so they stay stable across re-exports.
    """
    regions = (
        [{"kind": "land", "shape": s} for s in by_fill[LAND]]
        + [{"kind": "sea", "shape": s} for s in by_fill[SEA]]
        + [{"kind": "staging", "shape": s} for s in by_fill[STAGING]]
    )
    for r in regions:
        r["c"] = shape_centroid(r["shape"])
    regions.sort(key=lambda r: (round(r["c"][1] / 120), r["c"][0]))
    n = 0
    for r in regions:
        if r["kind"] != "staging":
            n += 1
            r["id"] = f"n{n:02d}"
    # p1 stages on the left of the map, p2 on the right.
    stages = sorted((r for r in regions if r["kind"] == "staging"), key=lambda r: r["c"][0])
    for owner, r in zip(("p1", "p2"), stages):
        r["id"] = f"{owner}-staging"
        r["owner"] = owner
    return regions


def point_seg_dist(p, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L))
    return math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy))


def boundary_dist(pt, shape):
    return min(
        point_seg_dist(pt, poly[i], poly[(i + 1) % len(poly)])
        for poly in shape["polys"]
        for i in range(len(poly))
    )


def region_finder(regions, tol=60.0):
    """Locate the region a point belongs to.

    Path segments abut their regions rather than overlapping them, so an endpoint
    can sit just outside. Measured across all 92 endpoints, the nearest boundary
    is never more than 54px away while the runner-up is never closer than 59px,
    so falling back to the nearest boundary within `tol` is unambiguous.
    """

    def node_at(pt):
        for r in regions:
            if in_shape(pt, r["shape"]):
                return r
        near = min(regions, key=lambda r: boundary_dist(pt, r["shape"]))
        return near if boundary_dist(pt, near["shape"]) <= tol else None

    return node_at


def extract_slots(regions, by_fill, node_at):
    """Count division spots per side, split by each node's divider line."""
    dividers = {}
    for s in by_fill[DIVIDER]:
        r = node_at(shape_centroid(s))
        assert r, "divider outside every region"
        dividers[r["id"]] = long_axis(s)

    spots = defaultdict(list)
    for s in by_fill[SPOT]:
        c = shape_centroid(s)
        r = node_at(c)
        assert r, f"division spot at {c} outside every region"
        spots[r["id"]].append(c)

    p1c = next(r["c"] for r in regions if r.get("owner") == "p1")
    for r in regions:
        pts = spots[r["id"]]
        if r["kind"] == "staging":
            assert not pts, "staging should hold no division spots"
            r["spots"] = None
            continue
        (x0, y0), (x1, y1) = dividers[r["id"]]
        # Sign of the cross product tells which half of the node a spot is in.
        groups = defaultdict(list)
        for p in pts:
            side = (x1 - x0) * (p[1] - y0) - (y1 - y0) * (p[0] - x0) > 0
            groups[side].append(p)
        a, b = groups[True], groups[False]

        def near(g):
            return min((dist(p, p1c) for p in g), default=math.inf)

        # The half closer to p1's staging is the half p1 deploys into.
        p1s, p2s = (a, b) if near(a) <= near(b) else (b, a)
        # Order each side's spots left-to-right so slot n is stable across runs.
        r["spots"] = {
            side: [{"x": round(p[0], 1), "y": round(p[1], 1)} for p in sorted(g)]
            for side, g in (("p1", p1s), ("p2", p2s))
        }
    return spots


def extract_adjacency(by_fill, node_at):
    """Each #D9D9D9 segment joins the two regions holding its endpoints."""
    adj = defaultdict(set)
    for s in by_fill[PATH]:
        a, b = long_axis(s)
        ra, rb = node_at(a), node_at(b)
        assert ra and rb, f"path segment endpoint outside every region: {a} {b}"
        assert ra["id"] != rb["id"], f"path segment starts and ends in {ra['id']}"
        adj[ra["id"]].add(rb["id"])
        adj[rb["id"]].add(ra["id"])
    return adj


def extract_arrows(by_fill, regions, node_at):
    """The 12 chevrons form 4 directional arrows; each points origin -> target."""
    ar = by_fill[ARROW]

    def apex_dir(s):
        """A chevron's pointing direction: from its wing-tip midpoint to its apex."""
        pts = [p for poly in s["polys"] for p in poly]
        a, b = long_axis(s)
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        ax, ay = b[0] - a[0], b[1] - a[1]
        length = math.hypot(ax, ay)
        apex = max(pts, key=lambda p: abs(ax * (p[1] - a[1]) - ay * (p[0] - a[0])) / length)
        v = (apex[0] - mid[0], apex[1] - mid[1])
        m = math.hypot(*v)
        return (v[0] / m, v[1] / m)

    # Chevrons of one arrow sit ~51px apart; distinct arrows are far apart.
    used, groups = set(), []
    for i in range(len(ar)):
        if i in used:
            continue
        group, queue = [i], [i]
        used.add(i)
        while queue:
            k = queue.pop()
            for j in range(len(ar)):
                if j not in used and dist(shape_centroid(ar[k]), shape_centroid(ar[j])) < 90:
                    used.add(j)
                    group.append(j)
                    queue.append(j)
        groups.append(group)
    assert len(groups) == 4, f"expected 4 arrows, clustered {len(groups)}"

    def march(p, v, maxd=900):
        """First region hit walking from p along v."""
        d = 6
        while d < maxd:
            r = node_at((p[0] + v[0] * d, p[1] + v[1] * d))
            if r:
                return r
            d += 6
        return None

    links = []
    for g in groups:
        assert len(g) == 3, f"arrow has {len(g)} chevrons, expected 3"
        vs = [apex_dir(ar[i]) for i in g]
        vx, vy = sum(v[0] for v in vs) / 3, sum(v[1] for v in vs) / 3
        m = math.hypot(vx, vy)
        vx, vy = vx / m, vy / m
        cs = [shape_centroid(ar[i]) for i in g]
        proj = sorted(cs, key=lambda c: c[0] * vx + c[1] * vy)
        src = march(proj[0], (-vx, -vy))
        dst = march(proj[-1], (vx, vy))
        assert src and dst, "arrow does not resolve to two regions"
        links.append({"from": src["id"], "to": dst["id"]})
    return sorted(links, key=lambda l: (l["from"], l["to"]))


def main():
    shapes = parse()
    by_fill = defaultdict(list)
    for s in shapes:
        by_fill[s["fill"]].append(s)
    for fill, n in EXPECT.items():
        got = len(by_fill[fill])
        assert got == n, f"{fill}: expected {n} shapes, found {got}"

    regions = build_regions(by_fill)
    node_at = region_finder(regions)
    spots = extract_slots(regions, by_fill, node_at)
    adj = extract_adjacency(by_fill, node_at)
    links = extract_arrows(by_fill, regions, node_at)

    # An indirect-fire origin need not be path-adjacent to its target.
    for l in links:
        l["phantomOrigin"] = l["to"] not in adj[l["from"]]

    nodes = []
    for r in regions:
        node = {
            "id": r["id"],
            "adjacency": sorted(adj[r["id"]]),
            "coord": {"x": round(r["c"][0], 1), "y": round(r["c"][1], 1)},
        }
        if r["kind"] == "staging":
            node["staging"] = r["owner"]
        else:
            node["sea"] = r["kind"] == "sea"
            # Slot counts are len(spots[side]) — not stored, so they cannot drift.
            node["spots"] = r["spots"]
            node["asymmetric"] = len(r["spots"]["p1"]) != len(r["spots"]["p2"])
        nodes.append(node)

    out = {"image": {"width": 2246, "height": 1684}, "nodes": nodes, "indirectFire": links}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n", encoding="utf8")

    # --- report -------------------------------------------------------------
    land = [r for r in regions if r["kind"] == "land"]
    sea = [r for r in regions if r["kind"] == "sea"]
    print(f"nodes: {len(land)} land + {len(sea)} sea = {len(land) + len(sea)} contested, "
          f"+2 staging")
    print(f"spots: {sum(len(v) for v in spots.values())} of 84 assigned")
    print(f"edges: {sum(len(v) for v in adj.values()) // 2} from 46 segments")
    counts = defaultdict(int)
    for r in regions:
        if r["spots"]:
            counts[(len(r["spots"]["p1"]), len(r["spots"]["p2"]))] += 1
    print("slot shapes (p1,p2):", dict(sorted(counts.items())))
    print("asymmetric:", [r["id"] for r in regions if r.get("spots") and
                          len(r["spots"]["p1"]) != len(r["spots"]["p2"])])
    print("degrees:", {r["id"]: len(adj[r["id"]]) for r in regions})
    for l in links:
        print(f"  indirect: {l['from']} -> {l['to']}"
              f"{' (phantom origin)' if l['phantomOrigin'] else ''}")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
