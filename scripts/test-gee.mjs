/* Diagnose a Google Earth Engine service-account key.
 *
 *   node scripts/test-gee.mjs                      # uses GEE_KEY_FILE from env/.env
 *   node scripts/test-gee.mjs ./secrets/key.json   # explicit path
 *
 * Prints the EXACT auth/init/compute error so you know what to fix.
 */
import fs from 'fs'
import path from 'path'

// Minimal .env loader (no dependency).
try {
  const envPath = path.resolve(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
} catch {}

const keyPath = process.argv[2] || process.env.GEE_KEY_FILE
let key
if (process.env.GEE_SERVICE_ACCOUNT_KEY && !keyPath) {
  key = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY)
} else if (keyPath && fs.existsSync(keyPath)) {
  key = JSON.parse(fs.readFileSync(keyPath, 'utf8'))
} else {
  console.error('❌ No key. Set GEE_KEY_FILE in .env or pass a path: node scripts/test-gee.mjs ./secrets/key.json')
  process.exit(1)
}

console.log('🔑 key project_id :', key.project_id)
console.log('🔑 client_email   :', key.client_email)
console.log('🔑 has private_key:', !!key.private_key)
console.log('')

const ee = (await import('@google/earthengine')).default
const project = process.env.GEE_PROJECT || key.project_id

const fail = (stage, err) => {
  console.error(`\n❌ FAILED at ${stage}:\n`, typeof err === 'string' ? err : (err?.message || JSON.stringify(err)))
  console.error('\nCommon fixes:')
  console.error(' • "Earth Engine API has not been used/ is disabled" → enable it:')
  console.error('     https://console.cloud.google.com/apis/library/earthengine.googleapis.com?project=' + project)
  console.error(' • "not registered" / "Not signed up" → register the project for EE:')
  console.error('     https://code.earthengine.google.com/register  (pick project ' + project + ')')
  console.error(' • "Permission denied" → give the service account the "Earth Engine Resource Writer" role, and')
  console.error('   make sure THIS service account email is allowed in your EE project.')
  process.exit(1)
}

console.log('① authenticating via private key…')
ee.data.authenticateViaPrivateKey(key, () => {
  console.log('   ✓ authenticated')
  console.log('② initializing (project = ' + project + ')…')
  ee.initialize(null, null, () => {
    console.log('   ✓ initialized')
    console.log('③ running a trivial compute (ee.Number(1).add(1))…')
    ee.Number(1).add(1).evaluate((val, err) => {
      if (err) return fail('compute', err)
      console.log('   ✓ compute returned:', val)
      console.log('④ building a real NDVI map tile URL over a small AOI…')
      const geom = ee.Geometry.Rectangle([36.78, -1.32, 36.86, -1.24])
      const img = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(geom).filterDate('2025-01-01', '2025-06-01')
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))
        .median().normalizedDifference(['B8', 'B4']).clip(geom)
      img.getMap({ min: -0.2, max: 0.8, palette: ['red', 'yellow', 'green'] }, (map, err) => {
        if (err) return fail('getMap', err)
        console.log('   ✓ tile URL:', (map?.urlFormat || '').slice(0, 90) + '…')
        console.log('\n✅ GEE IS WORKING. Restart the dev server and NDVI/DEM/LST will use GEE.')
        process.exit(0)
      })
    })
  }, (err) => fail('initialize', err), null, project)
}, (err) => fail('authenticate', err))

setTimeout(() => fail('timeout', 'no response after 30s'), 30_000)
