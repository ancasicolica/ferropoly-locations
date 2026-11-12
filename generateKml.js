/**
 *
 * Christian Kuster, CH-8342 Wernetshausen, christian@kusti.ch
 * Created: 12.11.2026
 **/
const fs = require('fs');
const path = require('path');

// Konfiguration: Eingabe- und Ausgabedatei
const INPUT_FILE = path.join(__dirname, 'location_db', 'locationDb.json');
const OUTPUT_FILE = path.join(__dirname, 'output', 'locations.kml');

// Hilfsfunktion zum Escapen von XML-Sonderzeichen (z. B. "&" in Ortsnamen)
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateKml(data) {
  const placemarks = data.locations.map((loc) => {
    // 1. Ortsname zusammensetzen: isoCountryCode anhängen, falls nicht "CH"
    const countrySuffix =
            loc.isoCountryCode && loc.isoCountryCode !== 'CH'
              ? ` (${loc.isoCountryCode})`
              : '';

    // 2. Ortsname und aktive Maps als Beschreibung/Kommentar aufbereiten
    let description = `${loc.name}${countrySuffix}`;
    if (loc.maps) {
      const activeMaps = Object.entries(loc.maps)
        .filter(([_, isActive]) => isActive === true)
        .map(([mapName]) => mapName);

      const mapsText =
              activeMaps.length > 0
                ? `Maps: ${activeMaps.join(', ')}`
                : 'Maps: keine';

      description += `\n${mapsText}`;
    }
    const descriptionXml = `\n      <description>${escapeXml(description)}</description>`;

    // 3. Koordinaten (Wichtig bei KML: Reihenfolge ist Längengrad,Breitengrad[,Höhe]!)
    const lng = loc.position.lng;
    const lat = loc.position.lat;
    const alt = loc.height !== undefined ? `,${loc.height}` : '';

    return `    <Placemark>
      <name></name>${descriptionXml}
      <Point>
        <coordinates>${lng},${lat}${alt}</coordinates>
      </Point>
    </Placemark>`;
  });

  // Komplettes KML-Dokument zusammenbauen
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(data.instance || 'Ferropoly Locations')}</name>
${placemarks.join('\n')}
  </Document>
</kml>`;
}

// Hauptausführung
try {
  const rawData = fs.readFileSync(INPUT_FILE, 'utf8');
  const jsonData = JSON.parse(rawData);

  if (!Array.isArray(jsonData.locations)) {
    throw new Error('Das JSON enthält kein gültiges "locations"-Array.');
  }

  const kmlContent = generateKml(jsonData);
  fs.writeFileSync(OUTPUT_FILE, kmlContent, 'utf8');

  console.log(`Erfolgreich! ${jsonData.locations.length} Orte wurden nach "${OUTPUT_FILE}" exportiert.`);
} catch (error) {
  console.error('Fehler beim Konvertieren:', error.message);
}
