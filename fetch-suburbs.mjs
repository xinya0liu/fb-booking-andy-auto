import fs from 'fs';
import path from 'path';

const KEY = process.env.GOOGLE_MAPS_KEY;
if (!KEY) { console.error('Missing GOOGLE_MAPS_KEY'); process.exit(1); }

const CSV = path.join(import.meta.dirname, 'suburbs.csv');
const lines = fs.readFileSync(CSV, 'utf8').split('\n');
const header = lines[0];
const rows = lines.slice(1).filter(l => l.trim());

async function lookup(suburb, postcode) {
  const body = {
    origin: { address: 'Eagleby QLD 4207, Australia' },
    destination: { address: `${suburb} QLD ${postcode}, Australia` },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    extraComputations: ['TOLLS'],
    units: 'METRIC',
  };
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) {
    const code = json.error.code;
    const msg = json.error.message || JSON.stringify(json.error);
    if (code === 429) {
      console.error(`\nQuota exceeded — stopping. Re-run tomorrow.\n${msg}`);
      process.exit(1);
    }
    console.warn(`  API error for ${suburb}: ${msg}`);
    return null;
  }
  if (!json.routes || !json.routes[0]) {
    console.warn(`  No route for ${suburb}`);
    return null;
  }
  const route = json.routes[0];
  const km = Math.round(route.distanceMeters / 100) / 10;
  const min = Math.round(parseInt(route.duration) / 60);
  const tolls = route.travelAdvisory?.tollInfo?.estimatedPrice;
  let tollReturn = '';
  let tollRoute = '';
  if (tolls && tolls.length > 0) {
    const oneway = tolls.reduce((s, t) => s + Number(t.units || 0) + (t.nanos || 0) / 1e9, 0);
    tollReturn = (Math.round(oneway * 2 * 100) / 100).toFixed(2);
    tollRoute = 'Yes';
  }
  return { km, min, toll: tollRoute ? 'Yes' : 'No', tollReturn };
}

const newLines = [header];
for (const line of rows) {
  const cols = line.split(',');
  const suburb = cols[0];
  const postcode = cols[1];
  if (suburb === 'Eagleby') { newLines.push(line); continue; }
  process.stdout.write(`Fetching ${suburb}... `);
  const r = await lookup(suburb, postcode);
  if (!r) { newLines.push(line); continue; }
  cols[2] = r.km;
  cols[3] = r.min;
  cols[4] = r.toll;
  cols[6] = r.tollReturn;
  console.log(`${r.km}km ${r.min}min toll=${r.toll}${r.tollReturn ? ' $'+r.tollReturn : ''}`);
  newLines.push(cols.join(','));
  await new Promise(res => setTimeout(res, 100)); // avoid rate limit
}

fs.writeFileSync(CSV, newLines.join('\n'));
console.log('\nDone! suburbs.csv updated.');
