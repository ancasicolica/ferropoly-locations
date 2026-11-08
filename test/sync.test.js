const assert = require('node:assert/strict');
const { Console } = require('node:console');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform, Writable } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');

const syncSource = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');

async function syncLocations(stations, locations) {
  const logs = [];
  const tables = [];
  const warnings = [];
  const reportChunks = [];
  const reportStream = new Writable({
    write(chunk, encoding, callback) {
      reportChunks.push(chunk.toString());
      callback();
    }
  });
  const renderedConsole = new Console({ stdout: reportStream, stderr: reportStream });
  const writes = [];
  let output;
  const mockFs = {
    createReadStream: () => Readable.from(stations, { objectMode: true }),
    readdirSync: () => ['locationDb-261108-090000.json'],
    readFileSync: () => JSON.stringify({ locations }),
    mkdirSync: () => {},
    writeFileSync: (filename, contents) => {
      writes.push({ filename, contents });
      if (filename.endsWith('.json')) output = JSON.parse(contents);
    }
  };
  const csv = () => new Transform({
    objectMode: true,
    transform(row, encoding, callback) { callback(null, row); }
  });
  const context = {
    require: (name) => ({ fs: mockFs, path, 'csv-parser': csv, 'node:console': require('node:console'), 'node:stream': require('node:stream') })[name],
    __dirname: path.join(__dirname, '..'),
    console: {
      log: (message) => {
        logs.push(message);
        renderedConsole.log(message);
      },
      table: (rows) => {
        tables.push(rows);
        renderedConsole.table(rows);
      },
      warn: (message) => {
        warnings.push(message);
        renderedConsole.warn(message);
      }
    }
  };

  await vm.runInNewContext(syncSource, context);
  return { logs, tables, warnings, output, writes, consoleText: reportChunks.join('') };
}

function station(name, latitude) {
  return { designationOfficial: name, Geoposition: `${latitude}, 8` };
}

function location(name, latitude) {
  return { name, uuid: 'location-1', position: { lat: latitude, lng: 8 } };
}

test('expands the search in 50 m steps until stations are found', async () => {
  const result = await syncLocations(
    [station('Closest', 47.001), station('Second', 47.0011)],
    [location('Old name', 47)]
  );

  assert.equal(result.output.locations[0].name, 'Closest');
  assert.ok(result.logs.some((message) => /mehrere Versuche/i.test(message) && /150m/.test(message)));
  assert.ok(result.logs.some((message) => /Mehrere Treffer.*150m/.test(message)));
  assert.equal(result.tables[0].length, 2);
  assert.equal(result.tables[0][0].ausgewaehlt, true);
  assert.equal(result.warnings.length, 0);
});

test('shows latitude and longitude in separate columns for each matching station', async () => {
  const result = await syncLocations(
    [station('Closest', 47.0001), station('Second', 47.0002)],
    [location('Old name', 47)]
  );

  assert.equal(result.tables[0].length, 2);
  assert.equal(result.tables[0][0].lat, 47.0001);
  assert.equal(result.tables[0][0].lng, 8);
  assert.equal(result.tables[0][1].lat, 47.0002);
  assert.equal(result.tables[0][1].lng, 8);
  assert.match(result.consoleText, /lat/);
  assert.match(result.consoleText, /lng/);
});

test('keeps the initial radius when it already contains a station', async () => {
  const result = await syncLocations([station('Nearby', 47.0001)], [location('Old name', 47)]);

  assert.equal(result.output.locations[0].name, 'Nearby');
  assert.equal(result.logs.some((message) => /mehrere Versuche/i.test(message)), false);
});

test('expands only to the first radius containing a station', async () => {
  const result = await syncLocations([station('Nearby', 47.0006)], [location('Old name', 47)]);

  assert.equal(result.output.locations[0].name, 'Nearby');
  assert.ok(result.logs.some((message) => /2\) für/.test(message) && /100m/.test(message)));
  assert.equal(result.tables.length, 1);
});

test('stops without looping when there are no valid official stations', async () => {
  const result = await syncLocations([], [location('Old name', 47)]);

  assert.equal(result.output.locations[0].name, 'Old name');
  assert.equal(result.warnings.length, 1);
});

test('does not expand indefinitely for invalid location coordinates', async () => {
  const result = await syncLocations([station('Official', 47)], [location('Old name', 'invalid')]);

  assert.equal(result.output.locations[0].name, 'Old name');
  assert.equal(result.warnings.length, 1);
});

test('finds a station just inside the 1 km limit', async () => {
  const result = await syncLocations([station('Within limit', 47.00899)], [location('Old name', 47)]);

  assert.equal(result.output.locations[0].name, 'Within limit');
  assert.ok(result.logs.some((message) => /20\) für/.test(message) && /1000m/.test(message)));
  assert.equal(result.warnings.length, 0);
});

test('stops after 1 km when the nearest station is farther away', async () => {
  const result = await syncLocations([station('Beyond limit', 47.00901)], [location('Old name', 47)]);

  assert.equal(result.output.locations[0].name, 'Old name');
  assert.equal(result.tables.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /1000m/);
  assert.ok(result.logs.some((message) => /1000m/.test(message)));
});

test('writes a Markdown report containing every console message and table in order', async () => {
  const result = await syncLocations(
    [station('Closest', 47.001), station('Second', 47.0011)],
    [location('Old name', 47), location('Far away', 48)]
  );

  assert.equal(result.writes.length, 2);
  const [json, report] = result.writes;
  assert.match(json.filename, /locationDb-synced-\d{6}-\d{6}\.json$/);
  assert.equal(report.filename, json.filename.replace(/\.json$/, '.md'));
  assert.match(report.filename, /[/\\]output[/\\]/);
  assert.match(report.contents, /^# .+\n\n```+text\n/);
  assert.ok(report.contents.includes(result.consoleText));
  assert.ok(result.consoleText.includes('Mehrere Versuche'));
  assert.ok(result.consoleText.includes('Mehrere Treffer'));
  assert.ok(result.consoleText.includes('Closest'));
  assert.ok(result.consoleText.includes('[WARNUNG]'));
  assert.ok(result.consoleText.includes('Zusammenfassung der Namensänderungen'));
  assert.ok(result.consoleText.includes('Neue Datenbank gespeichert unter:'));
});

test('reports the no-change summary even when there are no matching stations', async () => {
  const result = await syncLocations([], [location('Old name', 47)]);
  const report = result.writes.find(({ filename }) => filename.endsWith('.md'));

  assert.ok(report);
  assert.ok(report.contents.includes(result.consoleText));
  assert.ok(report.contents.includes('Keine Namensänderungen notwendig.'));
  assert.ok(report.contents.includes('[WARNUNG]'));
});

test('copies the country code of the closest station even when the name is unchanged', async () => {
  const result = await syncLocations(
    [
      { ...station('Other', 47.0002), isoCountryCode: 'DE' },
      { ...station('Official', 47.0001), isoCountryCode: 'CH' }
    ],
    [{ ...location('Official', 47), isoCountryCode: 'DE' }]
  );

  assert.equal(result.output.locations[0].isoCountryCode, 'CH');
  assert.equal(result.output.locations[0].name, 'Official');
});

test('keeps the existing country code when no station matches within 1 km', async () => {
  const oldLocation = { ...location('Old name', 47), isoCountryCode: 'CH' };
  const result = await syncLocations(
    [{ ...station('Far away', 48), isoCountryCode: 'DE' }],
    [oldLocation]
  );

  assert.equal(result.output.locations[0].isoCountryCode, 'CH');
});

test('does not erase an existing code when the matching CSV row has none', async () => {
  const result = await syncLocations(
    [station('Official', 47)],
    [{ ...location('Official', 47), isoCountryCode: 'CH' }]
  );

  assert.equal(result.output.locations[0].isoCountryCode, 'CH');
});

test('copies the business organisation abbreviation of the closest station even when the name is unchanged', async () => {
  const result = await syncLocations(
    [
      { ...station('Other', 47.0002), businessOrganisationAbbreviationDe: 'OTHER' },
      { ...station('Official', 47.0001), businessOrganisationAbbreviationDe: 'SBB' }
    ],
    [{ ...location('Official', 47), transportOrg: 'OLD' }]
  );

  assert.equal(result.output.locations[0].transportOrg, 'SBB');
  assert.equal(Object.hasOwn(result.output.locations[0], 'businessOrganisationAbbreviationDe'), false);
  assert.equal(result.output.locations[0].name, 'Official');
});

test('keeps the existing business organisation abbreviation when no station matches within 1 km', async () => {
  const result = await syncLocations(
    [{ ...station('Far away', 48), businessOrganisationAbbreviationDe: 'NEW' }],
    [{ ...location('Old name', 47), transportOrg: 'OLD' }]
  );

  assert.equal(result.output.locations[0].transportOrg, 'OLD');
});

test('does not erase an existing abbreviation when the matching CSV row has none', async () => {
  const result = await syncLocations(
    [station('Official', 47)],
    [{ ...location('Official', 47), transportOrg: 'OLD' }]
  );

  assert.equal(result.output.locations[0].transportOrg, 'OLD');
});

test('renames the abbreviation in older location exports even without a match', async () => {
  const result = await syncLocations(
    [],
    [{ ...location('Old name', 47), businessOrganisationAbbreviationDe: 'OLD' }]
  );

  assert.equal(result.output.locations[0].transportOrg, 'OLD');
  assert.equal(Object.hasOwn(result.output.locations[0], 'businessOrganisationAbbreviationDe'), false);
});

test('copies the height of the closest station even when the name is unchanged', async () => {
  const result = await syncLocations(
    [
      { ...station('Other', 47.0002), height: '450.5' },
      { ...station('Official', 47.0001), height: '520.3' }
    ],
    [{ ...location('Official', 47), height: 400 }]
  );

  assert.equal(result.output.locations[0].height, 520.3);
  assert.equal(result.output.locations[0].name, 'Official');
});

test('copies a zero height', async () => {
  const result = await syncLocations(
    [{ ...station('Official', 47), height: '0' }],
    [{ ...location('Official', 47), height: 400 }]
  );

  assert.equal(result.output.locations[0].height, 0);
});

test('keeps the existing height when no station matches within 1 km', async () => {
  const result = await syncLocations(
    [{ ...station('Far away', 48), height: '600' }],
    [{ ...location('Old name', 47), height: 400 }]
  );

  assert.equal(result.output.locations[0].height, 400);
});

test('does not erase an existing height when the matching CSV row has none', async () => {
  const result = await syncLocations(
    [{ ...station('Official', 47), height: '' }],
    [{ ...location('Official', 47), height: 400 }]
  );

  assert.equal(result.output.locations[0].height, 400);
});

test('does not replace an existing height with an invalid CSV value', async () => {
  const result = await syncLocations(
    [{ ...station('Official', 47), height: 'unknown' }],
    [{ ...location('Official', 47), height: 400 }]
  );

  assert.equal(result.output.locations[0].height, 400);
});