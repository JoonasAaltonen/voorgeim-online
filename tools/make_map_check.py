"""Build a self-contained map verification page from map.json + the Figma SVG.

    python tools/make_map_check.py <output.html>

A visual check of the extraction: node numbering, per-side slot counts,
adjacency, and the proposed indirect-fire arrows, drawn over the real map art.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT.parent / "Figma exports" / "Strategic map Figma.svg"
MAP = ROOT / "src" / "data" / "map.json"

CSS = """
:root {
  color-scheme: light dark;
  --parchment: #EFE9D8;
  --ground: #F2EEE4;
  --surface: #FBF9F3;
  --line: #D6CFBC;
  --ink: #23211C;
  --muted: #6E685A;
  --p1: #3A6BC4;
  --p2: #D9563A;
  --fire: #D2352A;
  --staging: #B15C84;
  --sea: #6C86C9;
  --shadow: 0 1px 2px rgba(35, 33, 28, .09), 0 8px 24px rgba(35, 33, 28, .07);
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #17181B;
    --surface: #212327;
    --line: #34373E;
    --ink: #E7E3D8;
    --muted: #8E9199;
    --p1: #6E9BEF;
    --p2: #FF8A66;
    --fire: #FF5647;
    --staging: #D982AC;
    --sea: #93A9E8;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .3);
  }
}
:root[data-theme="dark"] {
  --ground: #17181B;
  --surface: #212327;
  --line: #34373E;
  --ink: #E7E3D8;
  --muted: #8E9199;
  --p1: #6E9BEF;
  --p2: #FF8A66;
  --fire: #FF5647;
  --staging: #D982AC;
  --sea: #93A9E8;
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .3);
}
:root[data-theme="light"] {
  --ground: #F2EEE4;
  --surface: #FBF9F3;
  --line: #D6CFBC;
  --ink: #23211C;
  --muted: #6E685A;
  --p1: #3A6BC4;
  --p2: #D9563A;
  --fire: #D2352A;
  --staging: #B15C84;
  --sea: #6C86C9;
  --shadow: 0 1px 2px rgba(35, 33, 28, .09), 0 8px 24px rgba(35, 33, 28, .07);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font: 15px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif;
}
.wrap { max-width: 1440px; margin: 0 auto; padding: 28px 24px 64px; display: flex; flex-direction: column; gap: 20px; }

header { display: flex; flex-direction: column; gap: 6px; }
h1 {
  margin: 0;
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-weight: 600;
  font-size: clamp(1.5rem, 1.1rem + 1.5vw, 2.1rem);
  letter-spacing: -0.01em;
  text-wrap: balance;
}
.sub { color: var(--muted); max-width: 68ch; margin: 0; }

.tallies { display: flex; flex-wrap: wrap; gap: 8px; }
.tally {
  display: flex; align-items: baseline; gap: 7px;
  padding: 5px 11px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); font-size: .82rem; color: var(--muted);
}
.tally b { font-family: Consolas, ui-monospace, monospace; font-variant-numeric: tabular-nums; color: var(--ink); font-size: .9rem; }

.board { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 20px; align-items: start; }
@media (max-width: 1040px) { .board { grid-template-columns: minmax(0, 1fr); } }

.mapcard {
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
  box-shadow: var(--shadow); overflow: hidden;
}
.toolbar {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 9px 11px; border-bottom: 1px solid var(--line);
}
.toggle {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border: 1px solid var(--line); border-radius: 7px;
  background: transparent; color: var(--muted); cursor: pointer;
  font: inherit; font-size: .8rem;
}
.toggle:hover { color: var(--ink); border-color: var(--muted); }
.toggle[aria-pressed="true"] { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.toggle:focus-visible { outline: 2px solid var(--p1); outline-offset: 2px; }
.swatch { width: 9px; height: 9px; border-radius: 2px; }

.mapview { display: block; width: 100%; height: auto; }
.mapview .base { pointer-events: none; }

.edge { stroke: #2E2A22; stroke-width: 3; opacity: .35; }
.arrow { stroke: var(--fire); stroke-width: 7; fill: none; opacity: .95; }
.arrowhead { fill: var(--fire); }
.nodedot { cursor: pointer; }
.nodedot circle { fill: rgba(28,26,22,.82); stroke: #F7F3E8; stroke-width: 2.5; transition: fill .12s; }
.nodedot.sea circle { fill: rgba(44,62,120,.85); }
.nodedot.staging circle { fill: rgba(140,50,95,.9); }
.nodedot:hover circle, .nodedot.sel circle { fill: #C8961F; }
.nodedot.adj circle { fill: #2F7A46; }
.nodedot text {
  font-family: Consolas, ui-monospace, monospace; font-weight: 700;
  fill: #FFF9EA; text-anchor: middle; pointer-events: none;
}
.nid { font-size: 30px; }
.nslots { font-size: 22px; opacity: .82; }
.hidden { display: none; }

.side { display: flex; flex-direction: column; gap: 14px; }
.panel { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); padding: 14px; box-shadow: var(--shadow); }
.panel h2 {
  margin: 0 0 9px; font-size: .69rem; text-transform: uppercase; letter-spacing: .09em;
  color: var(--muted); font-weight: 700;
}
.kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: .86rem; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-family: Consolas, ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); font-size: .86rem; margin: 0; }

.fire { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.fire li {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-family: Consolas, ui-monospace, monospace; font-size: .84rem;
}
.pill {
  font-family: "Segoe UI", system-ui, sans-serif; font-size: .66rem;
  padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor;
}
.pill--phantom { color: var(--staging); }
.pill--real { color: var(--muted); }
.note { font-size: .78rem; color: var(--muted); margin: 9px 0 0; }
"""

JS = """
const M = window.__MAP__;
const byId = Object.fromEntries(M.nodes.map(n => [n.id, n]));
const layer = { edges: true, ids: true, fire: true };
let sel = null;

const q = s => document.querySelector(s);
const svgEl = (t, a) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", t);
  for (const k in a) e.setAttribute(k, a[k]);
  return e;
};

function drawEdges() {
  const g = q("#edges");
  const seen = new Set();
  for (const n of M.nodes) {
    for (const m of n.adjacency) {
      const key = [n.id, m].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const b = byId[m];
      g.appendChild(svgEl("line", {
        class: "edge", x1: n.coord.x, y1: n.coord.y, x2: b.coord.x, y2: b.coord.y,
      }));
    }
  }
}

function drawFire() {
  const g = q("#fire");
  M.indirectFire.forEach((l, i) => {
    const a = byId[l.from].coord, b = byId[l.to].coord;
    // Bow each arrow away from the straight edge so overlapping links stay legible.
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = 34;
    const cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow;
    // Stop short of the target dot so the head stays visible.
    const t = 0.86;
    const ex = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cx + t * t * b.x;
    const ey = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cy + t * t * b.y;
    g.appendChild(svgEl("path", {
      class: "arrow", d: `M${a.x} ${a.y} Q${cx} ${cy} ${ex} ${ey}`,
      "marker-end": "url(#head)",
    }));
  });
}

function drawNodes() {
  const g = q("#nodes");
  for (const n of M.nodes) {
    const staging = !!n.staging;
    const cls = "nodedot" + (n.sea ? " sea" : "") + (staging ? " staging" : "");
    const grp = svgEl("g", { class: cls, "data-id": n.id, tabindex: "0" });
    grp.appendChild(svgEl("circle", { cx: n.coord.x, cy: n.coord.y, r: staging ? 40 : 36 }));
    const id = svgEl("text", { class: "nid", x: n.coord.x, y: n.coord.y + (n.slots ? -2 : 10) });
    id.textContent = staging ? n.staging.toUpperCase() : n.id.slice(1);
    grp.appendChild(id);
    if (n.slots) {
      const s = svgEl("text", { class: "nslots", x: n.coord.x, y: n.coord.y + 21 });
      s.textContent = `${n.slots.p1}\\u2502${n.slots.p2}`;
      grp.appendChild(s);
    }
    grp.addEventListener("click", () => select(n.id));
    grp.addEventListener("focus", () => select(n.id));
    grp.addEventListener("mouseenter", () => hover(n.id));
    grp.addEventListener("mouseleave", () => hover(sel));
    g.appendChild(grp);
  }
}

function hover(id) {
  const adj = id ? new Set(byId[id].adjacency) : new Set();
  document.querySelectorAll(".nodedot").forEach(el => {
    el.classList.toggle("adj", adj.has(el.dataset.id));
    el.classList.toggle("sel", el.dataset.id === id);
  });
}

function select(id) {
  sel = id;
  hover(id);
  const n = byId[id];
  const fire = M.indirectFire.filter(l => l.from === id || l.to === id);
  q("#inspect").innerHTML = `
    <dl class="kv">
      <dt>Node</dt><dd>${n.id}</dd>
      <dt>Kind</dt><dd>${n.staging ? n.staging + " staging" : n.sea ? "sea" : "land"}</dd>
      ${n.slots ? `<dt>Slots</dt><dd>p1 ${n.slots.p1} \\u2502 p2 ${n.slots.p2}${n.asymmetric ? "  (asym)" : ""}</dd>` : ""}
      <dt>Paths</dt><dd>${n.adjacency.join(", ") || "\\u2014"}</dd>
      ${fire.length ? `<dt>Fire</dt><dd>${fire.map(l => `${l.from} \\u2192 ${l.to}`).join("<br>")}</dd>` : ""}
    </dl>`;
}

function drawFireList() {
  q("#firelist").innerHTML = M.indirectFire.map(l => `
    <li>
      <span>${l.from} \\u2192 ${l.to}</span>
      <span class="pill ${l.phantomOrigin ? "pill--phantom" : "pill--real"}">
        ${l.phantomOrigin ? "phantom origin" : "on a path"}
      </span>
    </li>`).join("");
}

for (const btn of document.querySelectorAll(".toggle")) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.layer;
    layer[k] = !layer[k];
    btn.setAttribute("aria-pressed", String(layer[k]));
    q("#" + k).classList.toggle("hidden", !layer[k]);
  });
}

drawEdges();
drawFire();
drawNodes();
drawFireList();
"""


def main():
    out = Path(sys.argv[1])
    data = json.loads(MAP.read_text(encoding="utf8"))
    svg = SVG.read_text(encoding="utf8")

    # Inline the map art as a nested <svg>: strip its XML prolog and neutralise
    # its ids so the export's defs cannot collide with the overlay's.
    art = svg[svg.index("<svg") :]
    art = re.sub(r'\b(id|clip-path|fill|mask)="([^"]*)(clip|mask|paint)([^"]*)"',
                 lambda m: f'{m.group(1)}="{m.group(2)}art_{m.group(3)}{m.group(4)}"', art)
    art = art.replace("<svg ", '<svg class="base" ', 1)
    art = re.sub(r'^<svg class="base" width="\d+" height="\d+"', '<svg class="base"', art)

    w, h = data["image"]["width"], data["image"]["height"]
    land = sum(1 for n in data["nodes"] if n.get("sea") is False)
    sea = sum(1 for n in data["nodes"] if n.get("sea"))
    spots = sum(n["slots"]["p1"] + n["slots"]["p2"] for n in data["nodes"] if n.get("slots"))
    edges = sum(len(n["adjacency"]) for n in data["nodes"]) // 2
    asym = [n["id"] for n in data["nodes"] if n.get("asymmetric")]

    html = f"""<title>Voorgeim — map extraction check</title>
<style>{CSS}</style>
<div class="wrap">
  <header>
    <h1>Strategic map — extraction check</h1>
    <p class="sub">
      Every node, slot count and path below was read out of the Figma export by
      <code>tools/extract_map.py</code>. Numbers are assigned top-left to bottom-right.
      Hover or click a node to trace its paths.
    </p>
  </header>

  <div class="tallies">
    <span class="tally">Contested nodes <b>{land + sea}</b></span>
    <span class="tally">Land <b>{land}</b></span>
    <span class="tally">Sea <b>{sea}</b></span>
    <span class="tally">Staging <b>2</b></span>
    <span class="tally">Division spots <b>{spots}</b></span>
    <span class="tally">Paths <b>{edges}</b></span>
    <span class="tally">Asymmetric <b>{len(asym)}</b></span>
  </div>

  <div class="board">
    <div class="mapcard">
      <div class="toolbar">
        <button class="toggle" data-layer="edges" aria-pressed="true" type="button">
          <span class="swatch" style="background:#2E2A22"></span>Paths</button>
        <button class="toggle" data-layer="nodes" aria-pressed="true" type="button">
          <span class="swatch" style="background:#C8961F"></span>Node numbers</button>
        <button class="toggle" data-layer="fire" aria-pressed="true" type="button">
          <span class="swatch" style="background:var(--fire)"></span>Indirect fire</button>
      </div>
      <svg class="mapview" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5"
                  markerHeight="5" orient="auto-start-reverse">
            <path class="arrowhead" d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        {art}
        <g id="edges"></g>
        <g id="fire"></g>
        <g id="nodes"></g>
      </svg>
    </div>

    <div class="side">
      <div class="panel">
        <h2>Inspector</h2>
        <div id="inspect"><p class="empty">Pick a node on the map.</p></div>
      </div>
      <div class="panel">
        <h2>Indirect fire — needs your check</h2>
        <ul class="fire" id="firelist"></ul>
        <p class="note">
          Read off the four red arrows. &ldquo;Phantom origin&rdquo; means the two nodes
          have no movement path between them, so the link is wired explicitly.
        </p>
      </div>
      <div class="panel">
        <h2>Asymmetric nodes</h2>
        <p class="note" style="margin:0">{", ".join(asym)}</p>
      </div>
    </div>
  </div>
</div>
<script>window.__MAP__ = {json.dumps(data)};</script>
<script>{JS}</script>
"""
    out.write_text(html, encoding="utf8")
    print("wrote", out, f"({len(html) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
