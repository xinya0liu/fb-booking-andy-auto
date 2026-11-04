import fs from 'fs';
import path from 'path';

const CSV = path.join(import.meta.dirname, 'suburbs.csv');
const OUT = path.join(import.meta.dirname, 'suburbs-map.html');

const lines = fs.readFileSync(CSV, 'utf8').split('\n');
const rows = lines.slice(1).filter(l => l.trim());

async function geocode(suburb, postcode) {
  const q = encodeURIComponent(`${suburb} QLD ${postcode} Australia`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
    headers: { 'User-Agent': 'andy-auto-suburb-map/1.0' }
  });
  const json = await res.json();
  if (!json[0]) return null;
  return { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) };
}

function color(km) {
  if (km === 0) return '#333';
  if (km <= 15) return '#2a7a2a';
  if (km <= 25) return '#f0a500';
  if (km <= 40) return '#e05c00';
  return '#cc0000';
}

const suburbs = [];
for (const line of rows) {
  const cols = line.split(',');
  const suburb = cols[0].trim();
  const postcode = cols[1].trim();
  const km = parseFloat(cols[2]) || 0;
  const min = parseInt(cols[3]) || 0;
  const toll = cols[4].trim();
  const tollReturn = cols[6].trim();
  process.stdout.write(`Geocoding ${suburb}... `);
  const coord = await geocode(suburb, postcode);
  if (!coord) { console.log('not found'); continue; }
  console.log(`${coord.lat}, ${coord.lng}`);
  suburbs.push({ suburb, km, min, toll, tollReturn, ...coord });
  await new Promise(r => setTimeout(r, 1100)); // Nominatim: max 1 req/sec
}

const markers = suburbs.map(s => {
  const c = color(s.km);
  const label = s.km === 0 ? 'BASE' : `${s.km}km`;
  const tollInfo = s.toll === 'Yes' ? ` | Toll $${s.tollReturn}` : '';
  const popup = `<b>${s.suburb}</b><br>${s.km}km · ${s.min}min${tollInfo}`;
  return `L.circleMarker([${s.lat},${s.lng}], {radius:7, color:'${c}', fillColor:'${c}', fillOpacity:0.85, weight:2})
    .addTo(map).bindPopup('${popup.replace(/'/g, "\\'")}')
    .bindTooltip('${s.suburb}', {permanent:true, direction:'right', className:'suburb-label'});`;
}).join('\n  ');

const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Andy Auto — Suburb Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  body { margin:0; font-family:sans-serif; }
  #map { height:100vh; }
  .legend { background:#fff; padding:10px 14px; border-radius:8px; line-height:1.8em; font-size:0.85em; }
  .legend span { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .suburb-label { background:none; border:none; box-shadow:none; font-size:11px; font-weight:600; color:#222; text-shadow:1px 1px 2px #fff, -1px -1px 2px #fff; white-space:nowrap; }
</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('map').setView([-27.71, 153.19], 10);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO', maxZoom:19
  }).addTo(map);

  ${markers}

  const legend = L.control({position:'bottomright'});
  legend.onAdd = () => {
    const d = L.DomUtil.create('div','legend');
    d.innerHTML = '<b>Distance from Eagleby</b><br>'
      + '<span style="background:#333"></span> Base (0km)<br>'
      + '<span style="background:#2a7a2a"></span> 0–15km<br>'
      + '<span style="background:#f0a500"></span> 15–25km<br>'
      + '<span style="background:#e05c00"></span> 25–40km<br>'
      + '<span style="background:#cc0000"></span> 40km+';
    return d;
  };
  legend.addTo(map);
</script>
</body></html>`;

fs.writeFileSync(OUT, html);
console.log(`\nDone! Open: ${OUT}`);
