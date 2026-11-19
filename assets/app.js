/* Forests in a Changing Climate — geoportal logic
 *
 * Every layer is an 8-bit grayscale PNG on a 0.1° lat/lon grid (data/*.png):
 * code 0 = no data, codes 1..255 = values on the scale described in data/meta.json.
 * The browser decodes the codes, colours them, reprojects the rows to Web Mercator
 * and hands the result to MapLibre as a canvas source. The same codes answer
 * hover/click queries and the country rankings in the side panel.
 */
(() => {
  'use strict';

  // ───────────────────────── grid & projection ─────────────────────────
  const NX = 3600, NY = 1400, RES = 0.1, TOP = 80, BOTTOM = -60;
  const mercY = lat => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const Y_TOP = mercY(TOP), Y_BOT = mercY(BOTTOM);
  const MW = NX, MH = Math.round(((Y_TOP - Y_BOT) * MW) / (2 * Math.PI));
  const ROW_MAP = new Int32Array(MH);
  for (let y = 0; y < MH; y++) {
    const my = Y_TOP - ((y + 0.5) / MH) * (Y_TOP - Y_BOT);
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    ROW_MAP[y] = Math.min(NY - 1, Math.max(0, Math.floor((TOP - lat) / RES)));
  }
  const R = 6371.0088;
  const CELL_AREA = new Float32Array(NY); // km²
  for (let i = 0; i < NY; i++) {
    const a = TOP - i * RES, b = a - RES;
    CELL_AREA[i] = R * R * (RES * Math.PI / 180) * (Math.sin(a * Math.PI / 180) - Math.sin(b * Math.PI / 180));
  }
  const cellIndex = (lng, lat) => {
    if (lat >= TOP || lat < BOTTOM || lng < -180 || lng >= 180) return -1;
    return Math.floor((TOP - lat) / RES) * NX + Math.floor((lng + 180) / RES);
  };

  // ───────────────────────── colours ─────────────────────────
  const RAMPS = {
    green: ['#a3cc8f', '#7db56d', '#57994f', '#377d3c', '#1f6230', '#0c4522'],
    heat: ['#f0a66e', '#e5834d', '#d06336', '#b24a2a', '#8e3621', '#662617'],
    plum: ['#d7a6c9', '#c27fb2', '#a65c99', '#874380', '#652e63', '#441c45'],
    plum5: ['#d7a6c9', '#b871a8', '#93488a', '#6a2e68', '#441c45'],
    rain: ['#8c510a', '#c48a3f', '#e6c98f', '#d6d6cf', '#9fd3c7', '#4fa79a', '#1f6f6a'],
  };
  const hex2abgr = h => {
    const n = parseInt(h.slice(1), 16);
    return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
  };

  // ───────────────────────── formatting ─────────────────────────
  const fmtPct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
  const fmtSigned = (v, d, unit) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}${unit}`;
  const fmtMha = km2 => {
    const mha = km2 / 1e4;
    return mha >= 100 ? `${Math.round(mha)} Mha` : mha >= 10 ? `${mha.toFixed(0)} Mha` : `${mha.toFixed(1)} Mha`;
  };
  const fmtBurn = v => (v < 0.001 ? '<0.1%' : v < 0.1 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`);
  const fmtCoord = (lng, lat) =>
    `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'W'}`;
  const ordinal = p => {
    const n = Math.round(p * 100);
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    return `${n}${s}`;
  };
  const NICE_NAMES = {
    'United States of America': 'United States', 'Dem. Rep. Congo': 'DR Congo', 'Central African Rep.': 'Central African Republic',
    'Bosnia and Herz.': 'Bosnia and Herzegovina', 'Dominican Rep.': 'Dominican Republic', 'Eq. Guinea': 'Equatorial Guinea',
    'Solomon Is.': 'Solomon Islands', 'S. Sudan': 'South Sudan', 'Congo': 'Rep. of the Congo', 'Macedonia': 'North Macedonia',
    'Fr. Polynesia': 'French Polynesia', 'W. Sahara': 'Western Sahara', 'Falkland Is.': 'Falkland Islands',
  };
  const aridityClass = v => (v < 0.2 ? 'arid' : v < 0.5 ? 'semi-arid' : v < 0.65 ? 'dry sub-humid' : 'humid');

  // ───────────────────────── map definitions ─────────────────────────
  const W_LABELS = { loss: 'Forest loss', fire: 'Fire', aridity: 'Aridity', climate: 'Climate stress' };

  const MAPS = {
    m1: {
      title: "Where Are the World's Forests?",
      layers: [
        {
          id: 'forest', name: 'Forest share', grid: () => 'forest', ramp: 'green', breaks: [0.1, 0.25, 0.5, 0.75, 0.9],
          legend: 'Share of each 0.1° cell covered by forest, 2000', ends: ['1%', '100%'], tick: v => `${Math.round(v * 100)}%`,
          fmt: v => fmtPct(v), note: 'Forest = trees taller than 5 m with at least 30% canopy cover.',
        },
        {
          id: 'canopy', name: 'Canopy density', grid: () => 'canopy', ramp: 'green', breaks: [10, 30, 50, 70, 85],
          legend: 'Mean tree canopy cover, 2000', ends: ['1%', '100%'], tick: v => `${v}%`,
          fmt: v => `${v.toFixed(0)}%`, note: 'Average canopy cover of all trees in the cell, including sparse woodland.',
        },
      ],
      method: `
        <p>Forest is mapped from 30 m Landsat imagery (Hansen et al., Global Forest Change v1.13): a pixel counts as forest when tree canopy covered at least 30% of it in 2000, the baseline year of the dataset. Plantations count as forest here; this is tree cover, not the land-use definition used by FAO.</p>
        <p>In Google Earth Engine the 30 m pixels were averaged to a 0.1° grid (about 11 km at the equator), giving the share of each cell that is forest and its mean canopy cover. Areas use the true size of each cell on the sphere. Country totals assign each cell to the country under its centre (Natural Earth 1:50m borders).</p>
        <p>Coverage is 60°S to 80°N. Map 03 shows how much of this forest has been lost since 2000.</p>`,
    },
    m2: {
      title: 'Where Are Forests Losing the Climate Battle?',
      layers: [
        {
          id: 'stress', name: 'Stress index', grid: s => `stress_${s.scen}`, ramp: 'heat', breaks: [0.15, 0.3, 0.45, 0.6, 0.75],
          legend: 'Climate stress index, 2041–2060 vs 1995–2014', ends: ['0', '1'], tick: v => v.toFixed(2),
          fmt: v => v.toFixed(2), note: 'Mean of warming, rainfall decline and VPD increase, each scaled 0–1.', topDir: -1,
        },
        {
          id: 'dt', name: 'Warming', grid: s => `dt_${s.scen}`, ramp: 'heat', breaks: [1, 1.5, 2, 2.5, 3],
          legend: 'Change in mean annual temperature', ends: ['', ''], tick: v => `+${v}°C`,
          fmt: v => fmtSigned(v, 1, ' °C'), note: 'Average of the 2041–2060 period against 1995–2014.', topDir: -1,
        },
        {
          id: 'dp', name: 'Rainfall', grid: s => `dp_${s.scen}`, ramp: 'rain', breaks: [-15, -7.5, -2, 2, 7.5, 15],
          legend: 'Change in annual precipitation', ends: ['', ''], tick: v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`,
          fmt: v => fmtSigned(v, 1, '%'), note: 'Brown = drier, teal = wetter. Rainfall is where climate models disagree most.', topDir: 1,
        },
        {
          id: 'dvpd', name: 'Air dryness', grid: s => `dvpd_${s.scen}`, ramp: 'heat', breaks: [0.02, 0.05, 0.1, 0.15, 0.25],
          legend: 'Change in vapour pressure deficit (kPa)', ends: ['', ''], tick: v => `+${v}`,
          fmt: v => fmtSigned(v, 2, ' kPa'), note: 'Higher VPD means thirstier air: trees lose more water and close their pores.', topDir: -1,
        },
      ],
      method: `
        <p>Climate projections come from NEX-GDDP-CMIP6, NASA's daily, bias-corrected and downscaled CMIP6 data at 0.25°. Each layer is the mean of five models (ACCESS-CM2, GFDL-ESM4, MIROC6, MPI-ESM1-2-HR, MRI-ESM2-0): the 2041–2060 average under each scenario minus the 1995–2014 average of the historical run.</p>
        <p>Vapour pressure deficit (VPD) is calculated from mean temperature and mean relative humidity (Tetens formula). This understates absolute VPD; the change between periods is what the map shows.</p>
        <p>The stress index averages three signals that weaken trees: warming, falling rainfall and rising VPD. Each is scaled 0–1 between its 2nd and 98th percentile across forested cells of both scenarios, so the two scenarios share one scale.</p>
        <p>Values are shown only where at least 10% of a 0.1° cell is forest (Map 01), and are interpolated bilinearly from the 0.25° model grid. Five models give a central estimate; single models differ, most of all on rainfall.</p>`,
    },
    m3: {
      title: 'Which Forests Are Most Vulnerable to Climate Change?',
      layers: [
        { id: 'composite', name: 'Combined', composite: true, ramp: 'plum5', legend: 'Combined vulnerability score, by fifths of world forest area' },
        {
          id: 'loss', name: 'Forest loss', grid: () => 'loss', ramp: 'plum', breaks: [0.02, 0.05, 0.1, 0.25, 0.5],
          legend: 'Share of 2000 forest lost, 2001–2025', ends: ['0%', '100%'], tick: v => `${Math.round(v * 100)}%`,
          fmt: v => fmtPct(v, v < 0.1 ? 1 : 0), note: 'Any stand-replacing loss: clearing, logging, plantation harvest and fire.', topDir: -1,
        },
        {
          id: 'fire', name: 'Fire', grid: () => 'fire', ramp: 'plum', breaks: [0.001, 0.005, 0.01, 0.05, 0.1],
          legend: 'Share of the cell burned per year, 2001–2025', ends: ['0%', ''], tick: v => `${+(v * 100).toFixed(1)}%`,
          fmt: fmtBurn, note: 'MODIS burned area at 500 m, averaged over 25 years.', topDir: -1,
        },
        {
          id: 'aridity', name: 'Aridity', grid: () => 'aridity', ramp: 'plum', breaks: [0.2, 0.5, 0.65, 1, 2], reverse: true,
          legend: 'Aridity index: precipitation ÷ potential evaporation', ends: ['', ''], tick: v => `${v}`,
          fmt: v => `${v.toFixed(2)} (${aridityClass(v)})`, listFmt: v => v.toFixed(2), note: 'Below 0.65 counts as dryland. Darker = drier.', topDir: 1,
        },
        {
          id: 'climate', name: 'Climate stress', grid: () => 'stress_245', ramp: 'plum', breaks: [0.15, 0.3, 0.45, 0.6, 0.75],
          legend: 'Climate stress index 2041–2060, SSP2-4.5 (Map 02)', ends: ['0', '1'], tick: v => v.toFixed(2),
          fmt: v => v.toFixed(2), note: 'The Map 02 index under the intermediate scenario.', topDir: -1,
        },
      ],
      components: [
        { key: 'loss', grid: 'loss', invert: false },
        { key: 'fire', grid: 'fire', invert: false },
        { key: 'aridity', grid: 'aridity', invert: true },
        { key: 'climate', grid: 'stress_245', invert: false },
      ],
      method: `
        <p>Four pressures are combined. Each is first turned into a percentile among the world's forest area (0 = least exposed, 1 = most exposed), so that very different units can be averaged:</p>
        <ul>
          <li><b>Forest loss</b>: share of the cell's 2000 forest lost in 2001–2025 (Hansen GFC). It includes clearing for farming, logging, plantation harvest and fire.</li>
          <li><b>Fire</b>: average share of the cell burned each year, 2001–2025 (MODIS MCD64A1).</li>
          <li><b>Aridity</b>: precipitation divided by potential evapotranspiration, 1991–2020 (TerraClimate). Drier scores higher.</li>
          <li><b>Climate stress</b>: the Map 02 index for 2041–2060 under SSP2-4.5.</li>
        </ul>
        <p>The combined score is the weighted mean of the four percentiles; weights start equal and can be changed with the sliders. Classes split world forest area into fifths, so "Very high" always marks the fifth of forest with the highest combined score.</p>
        <p>This is a relative index. It shows where pressures pile up compared with other forests; it is not a probability that a forest will be lost.</p>`,
    },
  };

  // ───────────────────────── state ─────────────────────────
  const state = {
    map: 'm1',
    layer: { m1: 'forest', m2: 'stress', m3: 'composite' },
    scen: '245',
    weights: { loss: 1, fire: 1, aridity: 1, climate: 1 },
  };
  let META, GEO, FOREST, COUNTRY, W, MIDX;     // shared data
  const grids = {};                            // key -> Promise<Uint8Array>
  const decoded = {};                          // key -> Float32Array(256) code -> value
  let composite = null, compBreaks = null;     // Float32Array over all cells, quintile breaks

  const $ = id => document.getElementById(id);

  // ───────────────────────── data loading ─────────────────────────
  async function pngToCodes(url) {
    const blob = await (await fetch(url)).blob();
    let src;
    try {
      src = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (e) {
      src = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = URL.createObjectURL(blob);
      });
    }
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const out = new Uint8Array(c.width * c.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
    return out;
  }
  function grid(key) {
    if (!grids[key]) {
      const p = pngToCodes(`data/${key}.png`);
      p.then(v => { p.done = v; }, () => { delete grids[key]; });
      grids[key] = p;
    }
    return grids[key];
  }
  function decodeTable(key) {
    if (decoded[key]) return decoded[key];
    const v = META.vars[key];
    const t = { linear: [x => x, x => x], sqrt: [Math.sqrt, x => x * x], log: [Math.log, Math.exp] }[v.scale];
    const a = t[0](v.min), b = t[0](v.max);
    const out = new Float32Array(256).fill(NaN);
    for (let c = 1; c < 256; c++) out[c] = t[1](a + ((c - 1) / 254) * (b - a));
    return (decoded[key] = out);
  }
  const rankTable = key => META.vars[key].rank;

  // ───────────────────────── colouring ─────────────────────────
  const colored = new Uint32Array(NX * NY);
  const canvas = document.createElement('canvas');
  canvas.width = MW; canvas.height = MH;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(MW, MH);
  const image32 = new Uint32Array(image.data.buffer);

  function layerDef(mapId = state.map, layerId = state.layer[mapId]) {
    return MAPS[mapId].layers.find(l => l.id === layerId);
  }
  function rampOf(L) {
    const r = RAMPS[L.ramp].slice();
    return L.reverse ? r.reverse() : r;
  }
  const classOf = (v, breaks) => {
    let k = 0;
    while (k < breaks.length && v >= breaks[k]) k++;
    return k;
  };
  function lutFor(L, key) {
    const dec = decodeTable(key), ramp = rampOf(L).map(hex2abgr);
    const lut = new Uint32Array(256);
    for (let c = 1; c < 256; c++) lut[c] = ramp[classOf(dec[c], L.breaks)];
    return lut;
  }

  async function computeComposite() {
    const comps = MAPS.m3.components;
    const codes = await Promise.all(comps.map(c => grid(c.grid)));
    const ranks = comps.map(c => rankTable(c.grid));
    const ws = comps.map(c => state.weights[c.key]);
    if (!composite) composite = new Float32Array(NX * NY).fill(NaN);
    const n = MIDX.length;
    const hist = new Float64Array(1001);
    for (let t = 0; t < n; t++) {
      const i = MIDX[t];
      let s = 0, sw = 0;
      for (let k = 0; k < 4; k++) {
        const w = ws[k];
        if (!w) continue;
        const c = codes[k][i];
        if (!c) continue;
        const r = ranks[k][c];
        s += w * (comps[k].invert ? 1 - r : r);
        sw += w;
      }
      const v = sw ? s / sw : NaN;
      composite[i] = v;
      if (sw) hist[Math.round(v * 1000)] += W[i];
    }
    // quintile breaks by forest area
    let total = 0;
    for (let b = 0; b <= 1000; b++) total += hist[b];
    compBreaks = [];
    let acc = 0, q = 1;
    for (let b = 0; b <= 1000 && q < 5; b++) {
      acc += hist[b];
      while (q < 5 && acc >= (total * q) / 5) { compBreaks.push((b + 0.5) / 1000); q++; }
    }
  }

  async function renderLayer() {
    const L = layerDef();
    showLoading(true);
    if (L.composite) {
      await computeComposite();
      const ramp = rampOf(L).map(hex2abgr);
      colored.fill(0);
      for (let t = 0; t < MIDX.length; t++) {
        const i = MIDX[t], v = composite[i];
        if (v === v) colored[i] = ramp[classOf(v, compBreaks)];
      }
    } else {
      const key = L.grid(state);
      const codes = await grid(key);
      const lut = lutFor(L, key);
      for (let i = 0; i < colored.length; i++) colored[i] = lut[codes[i]];
    }
    for (let y = 0; y < MH; y++) {
      const r = ROW_MAP[y] * NX;
      image32.set(colored.subarray(r, r + NX), y * MW);
    }
    ctx.putImageData(image, 0, 0);
    pushCanvas();
    showLoading(false);
  }

  // ───────────────────────── map ─────────────────────────
  let map, hoverIdx = 0, popup;
  function pushCanvas() {
    const src = map && map.getSource('grid');
    if (!src) return;
    src.play();
    map.triggerRepaint();
    requestAnimationFrame(() => requestAnimationFrame(() => src.pause()));
  }
  function showLoading(on) { $('loading').hidden = !on; }

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: { countries: { type: 'geojson', data: GEO, tolerance: 0.3 } },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': '#d7e0e3' } },
          { id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': '#f2f2ee' } },
          { id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': '#3c4a42', 'line-opacity': 0.32, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1] } },
          { id: 'hl', type: 'line', source: 'countries', filter: ['==', ['get', 'idx'], -1], paint: { 'line-color': '#17231b', 'line-width': 1.6 } },
        ],
      },
      center: [10, 20],
      zoom: 1.5,
      minZoom: 0,
      maxZoom: 7.5,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Hansen/UMD/Google/USGS/NASA · MODIS MCD64A1 · TerraClimate · NEX-GDDP-CMIP6 · Natural Earth',
    }));
    map.on('load', () => {
      if (map.getContainer().clientWidth < 600) map.jumpTo({ center: [15, 18], zoom: 0.2 });
      else map.fitBounds([[-168, -56], [178, 76]], { padding: 6, duration: 0 });
      map.addSource('grid', {
        type: 'canvas', canvas, animate: false,
        coordinates: [[-180, TOP], [180, TOP], [180, BOTTOM], [-180, BOTTOM]],
      });
      map.addLayer({ id: 'grid', type: 'raster', source: 'grid', paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, 'borders');
      renderLayer();
    });
    let pending = null;
    map.on('mousemove', e => {
      pending = e.lngLat;
      requestAnimationFrame(() => { if (pending) { readout(pending); pending = null; } });
    });
    map.getCanvas().addEventListener('mouseleave', () => { setHighlight(0); $('readout').innerHTML = defaultReadout; });
    map.on('click', e => openPopup(e.lngLat));
  }
  const defaultReadout = matchMedia('(hover: none)').matches
    ? 'Tap a cell to read its values.'
    : 'Hover over the map to read values. Click a cell for details.';

  function setHighlight(idx) {
    if (idx === hoverIdx) return;
    hoverIdx = idx;
    map.setFilter('hl', ['==', ['get', 'idx'], idx || -1]);
  }
  const countryName = idx => (idx ? NICE_NAMES[META.countries[idx - 1]] || META.countries[idx - 1] : '');

  // value of the current layer at cell i, or null
  function currentValue(i) {
    const L = layerDef();
    if (L.composite) {
      const v = composite && composite[i];
      if (!(v === v)) return null;
      const k = classOf(v, compBreaks);
      return { text: `${['Very low', 'Low', 'Medium', 'High', 'Very high'][k]} (${v.toFixed(2)})`, color: rampOf(L)[k] };
    }
    const key = L.grid(state);
    const p = grids[key];
    if (!p || !p.done) return null;
    const c = p.done[i];
    if (!c) return null;
    const v = decodeTable(key)[c];
    return { text: L.fmt(v), color: rampOf(L)[classOf(v, L.breaks)] };
  }

  function readout(ll) {
    const i = cellIndex(ll.lng, ll.lat);
    if (i < 0) { $('readout').innerHTML = defaultReadout; setHighlight(0); return; }
    const ci = COUNTRY[i];
    setHighlight(ci);
    const L = layerDef();
    const val = currentValue(i);
    const name = countryName(ci) || 'Open water';
    const vtxt = val
      ? `${L.name}: <span class="sw" style="background:${val.color}"></span><b>${val.text}</b>`
      : state.map === 'm1' ? 'No forest' : 'No forest mapped here';
    $('readout').innerHTML = `<b>${name}</b><span class="muted">${fmtCoord(ll.lng, ll.lat)}</span><span>${vtxt}</span>`;
  }

  // ───────────────────────── popup ─────────────────────────
  async function openPopup(ll) {
    const i = cellIndex(ll.lng, ll.lat);
    if (i < 0) return;
    const ci = COUNTRY[i];
    const row = Math.floor(i / NX);
    let html = `<div class="pp"><h3>${countryName(ci) || 'Open water'}</h3><div class="where">${fmtCoord(ll.lng, ll.lat)}, 0.1° cell of ${Math.round(CELL_AREA[row])} km²</div>`;
    const fdec = decodeTable('forest');
    const fshare = FOREST[i] ? fdec[FOREST[i]] : 0;

    if (state.map === 'm1') {
      const can = await grid('canopy');
      html += `<table>
        <tr><th>Forest share</th><td>${FOREST[i] ? fmtPct(fshare) : '<1%'}</td></tr>
        <tr><th>Forest area in cell</th><td>${Math.round(fshare * CELL_AREA[row])} km²</td></tr>
        <tr><th>Mean canopy cover</th><td>${can[i] ? decodeTable('canopy')[can[i]].toFixed(0) + '%' : '<1%'}</td></tr>
      </table><p class="note">Hansen Global Forest Change, year 2000.</p>`;
    } else if (state.map === 'm2') {
      const rows = MAPS.m2.layers;
      const keys = rows.flatMap(L => ['245', '585'].map(s => L.grid({ scen: s })));
      const codes = await Promise.all(keys.map(grid));
      if (!codes[0][i]) {
        html += `<p class="note">No forest mapped here: less than 10% of this cell is forest.</p>`;
      } else {
        html += `<table><thead><tr><th>2041–2060</th><th>SSP2-4.5</th><th>SSP5-8.5</th></tr></thead>`;
        rows.forEach((L, r) => {
          const a = codes[2 * r][i], b = codes[2 * r + 1][i];
          html += `<tr><th>${L.name}</th><td>${L.fmt(decodeTable(keys[2 * r])[a])}</td><td>${L.fmt(decodeTable(keys[2 * r + 1])[b])}</td></tr>`;
        });
        html += `</table><p class="note">Change against 1995–2014, mean of five CMIP6 models. Forest share ${fmtPct(fshare)}.</p>`;
      }
    } else {
      const comps = MAPS.m3.components;
      const codes = await Promise.all(comps.map(c => grid(c.grid)));
      if (!codes[0][i]) {
        html += `<p class="note">No forest mapped here: less than 10% of this cell is forest.</p>`;
      } else {
        const v = composite ? composite[i] : NaN;
        const k = v === v ? classOf(v, compBreaks) : -1;
        html += `<table><tr><th>Combined score</th><td><b>${k >= 0 ? ['Very low', 'Low', 'Medium', 'High', 'Very high'][k] : '–'}</b> ${v === v ? v.toFixed(2) : ''}</td></tr>`;
        comps.forEach((c, n) => {
          const L = MAPS.m3.layers.find(l => l.id === c.key);
          const code = codes[n][i];
          if (!code) { html += `<tr><th>${L.name}</th><td>no data</td></tr>`; return; }
          const val = decodeTable(c.grid)[code];
          const r = rankTable(c.grid)[code];
          const pr = c.invert ? 1 - r : r;
          html += `<tr><th>${L.name}</th><td>${L.fmt(val)} <span class="pct">${ordinal(pr)} pct</span></td></tr>`;
        });
        html += `</table><p class="note">Percentiles rank this cell against all of the world's forest area; higher means more exposed.</p>`;
      }
    }
    html += '</div>';
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ maxWidth: '340px', focusAfterOpen: false }).setLngLat(ll).setHTML(html).addTo(map);
  }

  // ───────────────────────── country rankings ─────────────────────────
  const MIN_FOREST_KM2 = 1e4; // 1 Mha
  async function topList() {
    const L = layerDef();
    const n = META.countries.length + 1;
    const sw = new Float64Array(n), sv = new Float64Array(n);
    let rows, title, fmt, sortDir = -1, neg = false;
    if (state.map === 'm1') {
      for (let i = 0; i < W.length; i++) if (W[i] > 0) sw[COUNTRY[i]] += W[i];
      rows = [...sw.keys()].filter(k => k > 0).map(k => ({ k, v: sw[k] }));
      title = 'Largest forest area, 2000';
      fmt = fmtMha;
    } else if (L.composite) {
      for (let t = 0; t < MIDX.length; t++) {
        const i = MIDX[t], v = composite[i];
        if (!(v === v)) continue;
        sw[COUNTRY[i]] += W[i];
        if (v >= compBreaks[3]) sv[COUNTRY[i]] += W[i];
      }
      rows = [...sw.keys()].filter(k => k > 0 && sw[k] >= MIN_FOREST_KM2).map(k => ({ k, v: sv[k] / sw[k] }));
      title = 'Share of forest in the “very high” class';
      fmt = v => fmtPct(v);
    } else {
      const key = L.grid(state);
      const codes = await grid(key);
      const dec = decodeTable(key);
      for (let t = 0; t < MIDX.length; t++) {
        const i = MIDX[t], c = codes[i];
        if (!c) continue;
        sw[COUNTRY[i]] += W[i];
        sv[COUNTRY[i]] += W[i] * dec[c];
      }
      rows = [...sw.keys()].filter(k => k > 0 && sw[k] >= MIN_FOREST_KM2).map(k => ({ k, v: sv[k] / sw[k] }));
      sortDir = L.topDir;
      fmt = L.fmt;
      neg = L.id === 'dp';
      const t = {
        stress: 'Highest climate stress', dt: 'Strongest warming', dp: 'Largest rainfall decline', dvpd: 'Largest rise in air dryness',
        loss: 'Largest share of forest lost', fire: 'Most burned each year', aridity: 'Driest forests', climate: 'Highest climate stress (SSP2-4.5)',
      }[L.id];
      title = `${t}${state.map === 'm2' ? `, ${state.scen === '245' ? 'SSP2-4.5' : 'SSP5-8.5'}` : ''}`;
    }
    rows.sort((a, b) => (sortDir < 0 ? b.v - a.v : a.v - b.v));
    rows = rows.slice(0, 10);
    const max = Math.max(...rows.map(r => Math.abs(r.v))) || 1;
    $('top-title').textContent = title;
    $('top-hint').textContent = (state.map === 'm1' ? '' : 'Countries with at least 1 Mha of forest. ') +
      'Hover a row to outline the country, click to zoom to it.';
    $('toplist').innerHTML = rows.map(r => `
      <li tabindex="0" data-idx="${r.k}">
        <span class="nm">${countryName(r.k)}</span>
        <span class="bar${neg && r.v < 0 ? ' neg' : ''}" style="width:${(Math.abs(r.v) / max) * 100}%"></span>
        <span class="val">${(L.listFmt || fmt)(r.v)}</span>
      </li>`).join('');
    return rows;
  }

  // ───────────────────────── panel ─────────────────────────
  function figures() {
    const S = META.stats;
    const sc = state.scen;
    const items = {
      m1: [
        [`${(S.forest_area_km2 / 1e7).toFixed(1)} bn`, 'hectares of forest in 2000'],
        [fmtPct(S.share_tropics), 'of it lies in the tropics'],
        [fmtPct(S.top5_share), 'is in just five countries'],
      ],
      m2: [
        [fmtSigned(S[`dt_${sc}`], 1, ' °C'), 'average warming of forested land'],
        [fmtPct(S[`dt2_${sc}`]), 'of forest area warms by more than 2 °C'],
        [fmtPct(S[`drier_${sc}`]), 'of forest area gets less rain'],
      ],
      m3: [
        [fmtPct(S.loss_km2 / S.forest_area_km2, 1), 'of 2000 forest was lost by 2025'],
        [fmtPct(S.fire_gt1), 'of forest is in landscapes burning >1% a year'],
        [fmtPct(S.dry_share, 1), 'of forest grows in drylands'],
      ],
    }[state.map];
    $('figures').innerHTML = items.map(([n, l]) => `<div class="fig"><span class="num">${n}</span><span class="lab">${l}</span></div>`).join('');
  }

  function lede(top5) {
    const S = META.stats;
    if (state.map === 'm1') {
      const names = top5.map(r => countryName(r.k));
      return `In 2000, forest covered about ${(S.forest_area_km2 / 1e6).toFixed(0)} million km², or ${fmtPct(S.forest_area_km2 / S.land_area_km2)} of the land between 60°S and 80°N. Two belts dominate: the tropical forests around the equator and the boreal forest north of 50°N hold ${fmtPct(S.share_tropics + S.share_high)} of it between them. ${names.slice(0, 4).join(', ')} and ${names[4]} have the most.`;
    }
    if (state.map === 'm2') {
      return `Forests are adapted to the climate they grew up in. By 2041–2060 that climate shifts under them: warmer everywhere, and in many places with less rain and thirstier air. The stress index combines the three signals; the darkest areas are where forests are pushed furthest from the conditions they know.`;
    }
    return `Climate change rarely acts alone. This map stacks four pressures — recent forest loss, fire, a dry climate and the 2050 climate stress from Map 02 — and ranks every forest against all others. Change the weights to see how the picture shifts.`;
  }

  function legend() {
    const L = layerDef();
    $('legend-title').textContent = L.legend;
    const ramp = rampOf(L);
    $('legend').innerHTML = ramp.map(c => `<span class="sw" style="background:${c}"></span>`).join('');
    const holder = $('legend').parentNode;
    holder.querySelectorAll('.legend-labels, .legend-cats').forEach(n => n.remove());
    if (L.composite) {
      const cats = document.createElement('div');
      cats.className = 'legend-cats';
      cats.innerHTML = ['Very low', 'Low', 'Medium', 'High', 'Very high'].map(s => `<span>${s}</span>`).join('');
      $('legend').after(cats);
      $('legend-note').textContent = 'Each class holds a fifth of the world’s forest area. Weights: ' +
        Object.entries(state.weights).map(([k, w]) => `${W_LABELS[k].toLowerCase()} ${w}`).join(', ') + '.';
      return;
    }
    const labels = document.createElement('div');
    labels.className = 'legend-labels';
    const n = ramp.length;
    let h = L.breaks.map((b, k) => `<span style="left:${((k + 1) / n) * 100}%">${L.tick(b)}</span>`).join('');
    if (L.ends[0]) h = `<span class="first" style="left:0">${L.ends[0]}</span>` + h;
    if (L.ends[1]) h += `<span class="last" style="left:100%">${L.ends[1]}</span>`;
    labels.innerHTML = h;
    $('legend').after(labels);
    $('legend-note').textContent = L.note || '';
  }

  function controls() {
    const M = MAPS[state.map];
    $('layer-switch').innerHTML = M.layers.map(L =>
      `<button role="radio" data-layer="${L.id}" aria-checked="${L.id === state.layer[state.map]}">${L.name}</button>`).join('');
    $('scenario-switch').hidden = state.map !== 'm2';
    $('scenario-switch').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.dataset.scen === state.scen));
    const wbox = $('weights');
    wbox.hidden = !(state.map === 'm3' && state.layer.m3 === 'composite');
    if (!wbox.hidden && !wbox.childElementCount) {
      wbox.innerHTML = `<div class="w-head"><span>Weights in the combined score</span><button type="button" id="w-reset">Equal weights</button></div>` +
        Object.keys(state.weights).map(k => `
          <label class="w-row"><span>${W_LABELS[k]}</span>
            <input type="range" min="0" max="4" step="1" value="${state.weights[k]}" data-w="${k}" aria-label="Weight of ${W_LABELS[k]}">
            <output data-o="${k}"></output></label>`).join('');
    }
    updateWeightOutputs();
  }
  function updateWeightOutputs() {
    const tot = Object.values(state.weights).reduce((a, b) => a + b, 0) || 1;
    document.querySelectorAll('[data-o]').forEach(o => { o.textContent = `${Math.round((state.weights[o.dataset.o] / tot) * 100)}%`; });
    document.querySelectorAll('[data-w]').forEach(i => { i.value = state.weights[i.dataset.w]; });
  }

  async function refresh({ panel = true } = {}) {
    document.body.dataset.map = state.map;
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.map === state.map));
    if (panel) {
      $('map-title').textContent = MAPS[state.map].title;
      $('method-body').innerHTML = MAPS[state.map].method;
      controls();
      figures();
    }
    if (map && map.getSource('grid')) await renderLayer();
    else if (layerDef().composite) await computeComposite();
    legend();
    const rows = await topList();
    $('map-lede').textContent = lede(rows.slice(0, 5));
    if (popup) popup.remove();
  }

  // ───────────────────────── events ─────────────────────────
  function bindUI() {
    document.querySelector('.tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-map]');
      if (!b || b.dataset.map === state.map) return;
      state.map = b.dataset.map;
      history.replaceState(null, '', `#${state.map}`);
      $('panel-body').scrollTop = 0;
      refresh();
    });
    $('layer-switch').addEventListener('click', e => {
      const b = e.target.closest('button[data-layer]');
      if (!b) return;
      state.layer[state.map] = b.dataset.layer;
      refresh();
    });
    $('scenario-switch').addEventListener('click', e => {
      const b = e.target.closest('button[data-scen]');
      if (!b) return;
      state.scen = b.dataset.scen;
      refresh();
    });
    let wTimer = null;
    $('weights').addEventListener('input', e => {
      const k = e.target.dataset.w;
      if (!k) return;
      state.weights[k] = +e.target.value;
      if (!Object.values(state.weights).some(Boolean)) { state.weights[k] = 1; }
      updateWeightOutputs();
      cancelAnimationFrame(wTimer);
      wTimer = requestAnimationFrame(() => refresh({ panel: false }));
    });
    $('weights').addEventListener('click', e => {
      if (e.target.id !== 'w-reset') return;
      Object.keys(state.weights).forEach(k => { state.weights[k] = 1; });
      updateWeightOutputs();
      refresh({ panel: false });
    });
    const list = $('toplist');
    list.addEventListener('mouseover', e => { const li = e.target.closest('li'); if (li) setHighlight(+li.dataset.idx); });
    list.addEventListener('mouseleave', () => setHighlight(0));
    const go = li => { if (li) flyToCountry(+li.dataset.idx); };
    list.addEventListener('click', e => go(e.target.closest('li')));
    list.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e.target.closest('li')); } });
    list.addEventListener('focusin', e => { const li = e.target.closest('li'); if (li) setHighlight(+li.dataset.idx); });
  }

  function flyToCountry(idx) {
    const f = GEO.features[idx - 1];
    if (!f || !f.geometry) return;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    // fit the largest part: avoids the antimeridian pieces of Russia, the USA or Fiji
    let best = null, bestA = -1;
    polys.forEach(p => {
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      p[0].forEach(([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
      const a = (x1 - x0) * (y1 - y0);
      if (a > bestA) { bestA = a; best = [[x0, y0], [x1, y1]]; }
    });
    setHighlight(idx);
    map.fitBounds(best, { padding: 40, maxZoom: 6, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900 });
  }

  // ───────────────────────── boot ─────────────────────────
  async function boot() {
    const h = location.hash.replace('#', '');
    if (MAPS[h]) state.map = h;
    document.body.dataset.map = state.map;
    showLoading(true);
    [META, GEO] = await Promise.all([
      fetch('data/meta.json').then(r => r.json()),
      fetch('data/countries.geojson').then(r => r.json()),
    ]);
    // forest weights (km² of forest per cell) and the forested-cell index used by maps 02/03:
    // the loss layer is exported exactly where >= 10 % of a land cell is forest
    let lossCodes;
    [FOREST, COUNTRY, lossCodes] = await Promise.all([grid('forest'), grid('countries'), grid('loss')]);
    const fdec = decodeTable('forest');
    W = new Float32Array(NX * NY);
    const mid = [];
    for (let i = 0; i < W.length; i++) {
      const c = FOREST[i];
      if (!c || !COUNTRY[i]) continue;
      W[i] = fdec[c] * CELL_AREA[(i / NX) | 0];
      if (lossCodes[i]) mid.push(i);
    }
    MIDX = Int32Array.from(mid);
    $('readout').textContent = defaultReadout;
    initMap();
    bindUI();
    await refresh();
  }
  boot().catch(err => {
    console.error(err);
    showLoading(false);
    $('readout').textContent = 'The map data could not be loaded. Reload the page; if it keeps failing, open it from GitHub Pages rather than from a local file.';
  });
})();
