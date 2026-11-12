/**
 * Ferropoly Locations Updater
 * This file is completely AI generated, I acted only as product manager...
 * (c) 2026 Christian Kuster, CH-8342 Wernetshausen
 */
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Console } = require('node:console');
const { Writable } = require('node:stream');

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const CSV_FILE = path.join(INPUT_DIR, 'didok.csv');
const MAX_DISTANCE_METERS = 50; // Search radius increment in meters.
const MAX_SEARCH_DISTANCE_METERS = 1000; // Maximum matching radius in meters.

/** Returns the most recent locationDb JSON file based on its filename timestamp. */
function getNewestJsonFile() {
  const files = fs.readdirSync(INPUT_DIR)
    .filter((file) => /^locationDb-\d{6}-\d{6}\.json$/.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error(`Keine locationDb-YYMMDD-HHMMSS.json in "${INPUT_DIR}" gefunden.`);
  }

  return path.join(INPUT_DIR, files[files.length - 1]);
}

/** Calculates the great-circle distance between two coordinates in meters using the Haversine formula. */
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Loads official stations and writes the synchronized JSON file and console report. */
async function runSync() {
  const officialStations = [];
  const reportChunks = [];
  const reportStream = new Writable({
    write(chunk, encoding, callback) {
      reportChunks.push(chunk.toString());
      callback();
    }
  });
  const reportConsole = new Console({ stdout: reportStream, stderr: reportStream });
  const output = {
    log: (...args) => { console.log(...args); reportConsole.log(...args); },
    warn: (...args) => { console.warn(...args); reportConsole.warn(...args); },
    table: (...args) => { console.table(...args); reportConsole.table(...args); }
  };

  output.log(`Lese CSV-Datei "${CSV_FILE}" ein...`);

  // 1. Read the CSV file.
  await new Promise((resolve, reject) => {
    fs.createReadStream(CSV_FILE)
      .pipe(csv({ separator: ';' }))
      .on('data', (row) => {
        const name = row['designationOfficial'];
        const geoposition = row['Geoposition'];
        const isoCountryCode = row['isoCountryCode'];
        const transportOrg = row['businessOrganisationAbbreviationDe'];
        const height = row['height'] && row['height'].trim() !== '' ? Number(row['height']) : undefined;

        // Only process rows with a name and a coordinate string.
        if (name && geoposition) {
          // Split coordinates such as "47.257, 8.608" at the comma.
          const coords = geoposition.split(',');

          if (coords.length === 2) {
            const lat = parseFloat(coords[0].trim());
            const lng = parseFloat(coords[1].trim());

            if (!isNaN(lat) && !isNaN(lng)) {
              officialStations.push({ name, lat, lng, isoCountryCode, transportOrg, height });
            }
          }
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  output.log(`${officialStations.length} offizielle Haltestellen erfolgreich in den Speicher geladen.`);

  // 2. Read the latest JSON file.
  const JSON_FILE = getNewestJsonFile();
  output.log(`Lese JSON-Datei "${JSON_FILE}" ein...`);
  const dbRaw = fs.readFileSync(JSON_FILE, 'utf8');
  const db = JSON.parse(dbRaw);
  const changes = [];

  output.log(`Starte räumlichen Abgleich für ${db.locations.length} Ferropoly-Haltestellen...`);

  // 3. Match each location with its nearest official station.
  for (let loc of db.locations) {
    if (loc.transportOrg === undefined && loc.businessOrganisationAbbreviationDe !== undefined) {
      loc.transportOrg = loc.businessOrganisationAbbreviationDe;
    }
    delete loc.businessOrganisationAbbreviationDe;

    const locLat = parseFloat(loc.position.lat);
    const locLng = parseFloat(loc.position.lng);

    let closestStation = null;
    let minDistance = Infinity;
    const distances = [];

    for (const official of officialStations) {
      const distance = getDistanceInMeters(locLat, locLng, official.lat, official.lng);
      distances.push({ station: official, distance });
      if (distance < minDistance) {
        minDistance = distance;
        closestStation = official;
      }
    }

    let searchRadius = MAX_DISTANCE_METERS;
    let attempts = 1;
    while (closestStation && minDistance > searchRadius && searchRadius < MAX_SEARCH_DISTANCE_METERS) {
      searchRadius = Math.min(searchRadius + MAX_DISTANCE_METERS, MAX_SEARCH_DISTANCE_METERS);
      attempts++;
    }

    if (attempts > 1) {
      output.log(`Mehrere Versuche (${attempts}) für "${loc.name}" (${loc.uuid}): Suchradius auf ${searchRadius}m erweitert.`);
      if (closestStation && minDistance <= searchRadius) {
        output.log(`Treffer: ${closestStation.name}, Distanz: ${Math.round(minDistance)}m, Position aus CSV: ${closestStation.lat}, ${closestStation.lng}`);
      }
    }

    const matches = distances.filter(({ distance }) => distance <= searchRadius);
    if (matches.length > 1) {
      output.log(`Mehrere Treffer im Umkreis von ${searchRadius}m für "${loc.name}" (${loc.uuid}):`);
      output.table(matches.map(({ station, distance }) => ({
        name: station.name,
        position: `${station.lat}, ${station.lng}`,
        distanzMetern: Math.round(distance * 10) / 10,
        ausgewaehlt: station === closestStation
      })));
    }

    // Update the name when the nearest station is within the expanded matching radius.
    if (closestStation && minDistance <= searchRadius) {
      if (closestStation.isoCountryCode) {
        loc.isoCountryCode = closestStation.isoCountryCode;
      }
      if (closestStation.transportOrg) {
        loc.transportOrg = closestStation.transportOrg;
      }
      if (Number.isFinite(closestStation.height)) {
        loc.height = closestStation.height;
      }
      if (loc.name !== closestStation.name) {
        changes.push({
          uuid: loc.uuid,
          alterName: loc.name,
          neuerName: closestStation.name,
          isoCountryCode: loc.isoCountryCode,
          distanzMetern: Math.round(minDistance)
        });

        loc.name = closestStation.name;
      }
    } else if (closestStation) {
      output.warn(`[WARNUNG] Keine offizielle Haltestelle im Umkreis von ${MAX_SEARCH_DISTANCE_METERS}m für "${loc.name}" gefunden.`);
    } else {
      output.warn(`[WARNUNG] Keine offizielle Haltestelle mit berechenbarer Entfernung für "${loc.name}" gefunden.`);
    }
  }

  // 4. Save the updated JSON file.
  const now = new Date();
  db.timestamp = now.toISOString();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  // Format each date and time component as two digits for the output filename.
  const pad = (value) => String(value).padStart(2, '0');
  const dateTime = `${String(now.getFullYear()).slice(-2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const outputFilename = path.join(OUTPUT_DIR, `locationDb-synced-${dateTime}.json`);
  fs.writeFileSync(outputFilename, JSON.stringify(db, null, 2));

  output.log('\n--- Zusammenfassung der Namensänderungen ---');
  if(changes.length > 0) {
    output.table(changes);
  } else {
    output.log("Keine Namensänderungen notwendig. Alle Haltestellen sind aktuell.");
  }

  output.log(`\nFertig! ${changes.length} Haltestellen wurden aktualisiert.`);
  output.log(`Neue Datenbank gespeichert unter: ${outputFilename}`);

  const reportText = reportChunks.join('');
  let fence = '```';
  while (reportText.includes(fence)) fence += '`';
  const reportFilename = path.join(OUTPUT_DIR, `locationDb-synced-${dateTime}.md`);
  fs.writeFileSync(reportFilename, `# Abgleichsbericht\n\n${fence}text\n${reportText}${fence}\n`);
}

runSync();
