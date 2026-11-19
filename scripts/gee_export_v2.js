/*  Forest & climate geoportal — data export, v2 (Google Earth Engine, Code Editor)
 *
 *  Fixes the three failures of v1 by computing in much smaller tiles (shardSize)
 *  and by making the CMIP6 reduction lighter. terraclimate_01deg.tif from v1 is
 *  fine and is NOT re-exported here.
 *
 *  Output files (EPSG:4326, Google Drive / forest_portal):
 *   1. hansen_cover_01deg.tif  0.1°  uint16  Hansen GFC v1.13
 *        b1 treecover2000_mean  mean canopy cover, % x 100
 *        b2 forest2000_frac     share of cell with canopy >= 30 % in 2000, x 10000
 *   2. hansen_loss_01deg.tif   0.1°  uint16
 *        b1 loss_frac           share of cell: forest lost 2001–2025, x 10000
 *   3. fire_01deg.tif          0.1°  uint16  MODIS MCD64A1 burned area 2001–2025
 *        b1 burn_rate           mean share of cell burned per year, x 10000
 *        b2 burn_rate_forest    same, counting only MODIS forest pixels, x 10000
 *        b3 modis_forest_frac   share of cell that is forest (IGBP 1–5, 2001), x 10000
 *   4–6. cmip6_hist_1995_2014.tif, cmip6_ssp245_2041_2060.tif,
 *        cmip6_ssp585_2041_2060.tif   0.25° float32, NEX-GDDP-CMIP6, 5-model mean
 *        b1 tas (K)   b2 pr (kg m-2 s-1)   b3 hurs (%)
 */

var FOLDER  = 'forest_portal';
var REGION  = ee.Geometry.Rectangle([-180, -60, 180, 80], null, false);
var GRID    = [0.1,  0, -180, 0, -0.1,  80];   // 0.1° target grid
var GRID001 = [0.01, 0, -180, 0, -0.01, 80];   // 0.01° intermediate grid (40 x 40 Hansen pixels)

// ───────────────────────── 1–2. Hansen Global Forest Change ─────────────────────────
// v1 error: one 256-px output tile needed 102 400 x 102 400 source pixels (> 2^31).
// With shardSize 16 a tile needs 6 400 x 6 400.
var gfc = ee.Image('UMD/hansen/global_forest_change_2025_v1_13');
var forest2000 = gfc.select('treecover2000').gte(30);

function hansenTo01(img, scaleFactors) {
  return img.unmask(0)
    .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 4096})
    .reproject({crs: 'EPSG:4326', crsTransform: GRID001})
    .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 1024})
    .reproject({crs: 'EPSG:4326', crsTransform: GRID})
    .multiply(ee.Image.constant(scaleFactors))
    .round().toUint16();
}

var hansenCover = hansenTo01(ee.Image.cat([
  gfc.select('treecover2000').rename('treecover2000_mean'),
  forest2000.rename('forest2000_frac')
]), [100, 10000]);

var hansenLoss = hansenTo01(
  gfc.select('loss').eq(1).and(forest2000).rename('loss_frac'), [10000]);

Export.image.toDrive({
  image: hansenCover, description: 'hansen_cover_01deg', fileNamePrefix: 'hansen_cover_01deg',
  folder: FOLDER, region: REGION, crs: 'EPSG:4326', crsTransform: GRID,
  shardSize: 16, fileDimensions: 4096, maxPixels: 1e13
});
Export.image.toDrive({
  image: hansenLoss, description: 'hansen_loss_01deg', fileNamePrefix: 'hansen_loss_01deg',
  folder: FOLDER, region: REGION, crs: 'EPSG:4326', crsTransform: GRID,
  shardSize: 16, fileDimensions: 4096, maxPixels: 1e13
});

// ───────────────────────── 3. MODIS burned area ─────────────────────────
// v1 error: sinusoidal -> lat/lon reprojection of a 256-px tile was too large near
// the poles (11030 x 6147). With shardSize 64 the same step is ~16x smaller.
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
  folder: FOLDER, region: REGION, crs: 'EPSG:4326', crsTransform: GRID,
  shardSize: 64, fileDimensions: 4096, maxPixels: 1e13
});

// ───────────────────────── 4–6. CMIP6 projections (NEX-GDDP-CMIP6) ─────────────────────────
// v1 failed after 30–60 min of heavy compute: 36 500 daily images per tile plus a
// per-image VPD calculation. v2 takes plain means of three bands (VPD is derived
// afterwards from mean tas and hurs), uses small tiles and stops at 84°N.
var cmip = ee.ImageCollection('NASA/GDDP-CMIP6');
var MODELS = ['ACCESS-CM2', 'GFDL-ESM4', 'MIROC6', 'MPI-ESM1-2-HR', 'MRI-ESM2-0'];
var GRID25 = [0.25, 0, -180, 0, -0.25, 84];
var REGION25 = ee.Geometry.Rectangle([-180, -60, 180, 84], null, false);

function ensembleMean(scenario, y0, y1) {
  var perModel = MODELS.map(function (m) {
    return cmip.filter(ee.Filter.eq('model', m))
      .filter(ee.Filter.eq('scenario', scenario))
      .filterDate(y0 + '-01-01', (y1 + 1) + '-01-01')
      .select(['tas', 'pr', 'hurs'])
      .mean();
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
    folder: FOLDER, region: REGION25, crs: 'EPSG:4326', crsTransform: GRID25,
    shardSize: 32, fileDimensions: 4096, maxPixels: 1e13
  });
});

Map.setCenter(20, 15, 2);
Map.addLayer(gfc.select('treecover2000'), {min: 0, max: 100, palette: ['#f7f7f2', '#0b5d2a']}, 'Tree cover 2000');
print('6 export tasks created — open the Tasks tab and press Run on each.');
