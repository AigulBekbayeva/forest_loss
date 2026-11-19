/*  Forest & climate geoportal — data export (Google Earth Engine, Code Editor)
 *
 *  Paste into https://code.earthengine.google.com , press Run, then start the
 *  6 tasks in the Tasks tab. Results land in Google Drive / forest_portal.
 *
 *  Output files (all EPSG:4326):
 *   1. hansen_01deg.tif      0.1°  uint16  Hansen GFC v1.13 (2000–2025)
 *        b1 treecover2000_mean  mean canopy cover, % x 100
 *        b2 forest2000_frac     share of cell with canopy >= 30 % in 2000, x 10000
 *        b3 loss_frac           share of cell: forest lost 2001–2025, x 10000
 *        b4 loss_recent_frac    share of cell: forest lost 2016–2025, x 10000
 *        b5 land_frac           share of cell that is land, x 10000
 *   2. fire_01deg.tif        0.1°  uint16  MODIS MCD64A1 burned area 2001–2025
 *        b1 burn_rate           mean share of cell burned per year, x 10000
 *        b2 burn_rate_forest    same, counting only MODIS forest pixels, x 10000
 *        b3 modis_forest_frac   share of cell that is forest (IGBP 1–5, 2001), x 10000
 *   3. terraclimate_01deg.tif 0.1° int16   TerraClimate, mm/year (-1 = no data)
 *        b1 pr_1991_2020   b2 pet_1991_2020   b3 def_1991_2020   b4 def_1961_1990
 *   4–6. cmip6_hist_1995_2014.tif, cmip6_ssp245_2041_2060.tif,
 *        cmip6_ssp585_2041_2060.tif   0.25° float32, NEX-GDDP-CMIP6, 5-model mean
 *        b1 tas (K)   b2 tasmax (K)   b3 pr (kg m-2 s-1)   b4 vpd (kPa)
 */

var FOLDER = 'forest_portal';
var REGION = ee.Geometry.Rectangle([-180, -60, 180, 80], null, false);
var GRID   = [0.1, 0, -180, 0, -0.1, 80];          // 0.1° target grid
var GRID30 = [1 / 120, 0, -180, 0, -1 / 120, 80];  // 30" intermediate grid

// ───────────────────────── 1. Hansen Global Forest Change ─────────────────────────
var gfc = ee.Image('UMD/hansen/global_forest_change_2025_v1_13');
var forest2000 = gfc.select('treecover2000').gte(30);

var hansen = ee.Image.cat([
  gfc.select('treecover2000').rename('treecover2000_mean'),
  forest2000.rename('forest2000_frac'),
  gfc.select('loss').eq(1).and(forest2000).rename('loss_frac'),
  gfc.select('lossyear').gte(16).and(forest2000).rename('loss_recent_frac'),
  gfc.select('datamask').eq(1).rename('land_frac')
]).unmask(0).float();

// 30 m -> 30" -> 0.1° (two steps keep each aggregation under the pixel limit)
var hansen01 = hansen
  .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 4096})
  .reproject({crs: 'EPSG:4326', crsTransform: GRID30})
  .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 4096})
  .reproject({crs: 'EPSG:4326', crsTransform: GRID})
  .multiply(ee.Image.constant([100, 10000, 10000, 10000, 10000]))
  .round().toUint16();

Export.image.toDrive({
  image: hansen01, description: 'hansen_01deg', fileNamePrefix: 'hansen_01deg',
  folder: FOLDER, region: REGION, crs: 'EPSG:4326', crsTransform: GRID, maxPixels: 1e13
});

// ───────────────────────── 2. MODIS burned area ─────────────────────────
var mcd = ee.ImageCollection('MODIS/061/MCD64A1').select('BurnDate');
var modisProj = mcd.first().projection();
var Y0 = 2001, Y1 = 2025, yearly = [];
for (var y = Y0; y <= Y1; y++) {
  yearly.push(mcd.filterDate(y + '-01-01', (y + 1) + '-01-01').max().gt(0).unmask(0));
}
var burnRate = ee.ImageCollection(yearly).sum().divide(Y1 - Y0 + 1);   // 0..1 per year

var lc = ee.ImageCollection('MODIS/061/MCD12Q1')
  .filterDate('2001-01-01', '2002-01-01').first().select('LC_Type1');
var modisForest = lc.gte(1).and(lc.lte(5)).unmask(0);

var fire01 = ee.Image.cat([
  burnRate.rename('burn_rate'),
  burnRate.multiply(modisForest).rename('burn_rate_forest'),
  modisForest.rename('modis_forest_frac')
]).float()
  .setDefaultProjection(modisProj)
  .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 4096})
  .reproject({crs: 'EPSG:4326', crsTransform: GRID})
  .multiply(10000).round().toUint16();

Export.image.toDrive({
  image: fire01, description: 'fire_01deg', fileNamePrefix: 'fire_01deg',
  folder: FOLDER, region: REGION, crs: 'EPSG:4326', crsTransform: GRID, maxPixels: 1e13
});

// ───────────────────────── 3. TerraClimate (aridity, water deficit) ─────────────────────────
var tc = ee.ImageCollection('IDAHO_EPSCOR/TERRACLIMATE');
var tcProj = tc.first().projection();
function annualMean(band, y0, y1, scale) {            // mm per year
  return tc.filterDate(y0 + '-01-01', (y1 + 1) + '-01-01').select(band)
    .sum().multiply(scale / (y1 - y0 + 1));
}
var terra01 = ee.Image.cat([
  annualMean('pr',  1991, 2020, 1).rename('pr_1991_2020'),
  annualMean('pet', 1991, 2020, 0.1).rename('pet_1991_2020'),
  annualMean('def', 1991, 2020, 0.1).rename('def_1991_2020'),
  annualMean('def', 1961, 1990, 0.1).rename('def_1961_1990')
]).float()
  .setDefaultProjection(tcProj)
  .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 1024})
  .reproject({crs: 'EPSG:4326', crsTransform: GRID})
  .round().unmask(-1).toInt16();

Export.image.toDrive({
  image: terra01, description: 'terraclimate_01deg', fileNamePrefix: 'terraclimate_01deg',
  folder: FOLDER, region: REGION, crs: 'EPSG:4326', crsTransform: GRID, maxPixels: 1e13
});

// ───────────────────────── 4–6. CMIP6 projections (NEX-GDDP-CMIP6) ─────────────────────────
var cmip = ee.ImageCollection('NASA/GDDP-CMIP6');
var MODELS = ['ACCESS-CM2', 'GFDL-ESM4', 'MIROC6', 'MPI-ESM1-2-HR', 'MRI-ESM2-0'];
var GRID25 = [0.25, 0, -180, 0, -0.25, 90];
var REGION25 = ee.Geometry.Rectangle([-180, -60, 180, 90], null, false);

function addVpd(img) {                                 // daily VPD from tas + hurs, kPa
  var t = img.select('tas').subtract(273.15);
  var es = t.multiply(17.27).divide(t.add(237.3)).exp().multiply(0.6108);
  var vpd = es.multiply(ee.Image(1).subtract(img.select('hurs').divide(100)))
    .max(0).rename('vpd');
  return img.select(['tas', 'tasmax', 'pr']).addBands(vpd);
}
function ensembleMean(scenario, y0, y1) {
  var perModel = MODELS.map(function (m) {
    return cmip.filter(ee.Filter.eq('model', m))
      .filter(ee.Filter.eq('scenario', scenario))
      .filterDate(y0 + '-01-01', (y1 + 1) + '-01-01')
      .map(addVpd).mean();
  });
  return ee.ImageCollection(perModel).mean().float();
}
[
  ['historical', 1995, 2014, 'cmip6_hist_1995_2014'],
  ['ssp245',     2041, 2060, 'cmip6_ssp245_2041_2060'],
  ['ssp585',     2041, 2060, 'cmip6_ssp585_2041_2060']
].forEach(function (p) {
  Export.image.toDrive({
    image: ensembleMean(p[0], p[1], p[2]), description: p[3], fileNamePrefix: p[3],
    folder: FOLDER, region: REGION25, crs: 'EPSG:4326', crsTransform: GRID25, maxPixels: 1e13
  });
});

// Quick look so you can see the script is alive before starting the tasks
Map.setCenter(20, 15, 2);
Map.addLayer(gfc.select('treecover2000'), {min: 0, max: 100, palette: ['#f7f7f2', '#0b5d2a']}, 'Tree cover 2000');
print('6 export tasks created — open the Tasks tab and press Run on each.');
