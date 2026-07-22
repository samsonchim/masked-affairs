const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'submissions.json');
const RUNTIME_DATA_FILE = path.join('/tmp', 'masked-submissions.json');

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err.message);
    return [];
  }
}

function writeJsonFile(filePath, rows) {
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
}

function readLocalSubmissions() {
  const bundled = readJsonFile(DATA_FILE);
  const runtime = readJsonFile(RUNTIME_DATA_FILE);
  const merged = new Map();

  [...bundled, ...runtime].forEach((row) => {
    if (row && row.id != null) merged.set(String(row.id), row);
  });

  return Array.from(merged.values()).sort((a, b) => {
    const aTime = new Date(a.receivedAt || 0).getTime();
    const bTime = new Date(b.receivedAt || 0).getTime();
    return bTime - aTime;
  });
}

function appendLocalSubmission(entry) {
  const rows = readJsonFile(RUNTIME_DATA_FILE);
  rows.push(entry);
  writeJsonFile(RUNTIME_DATA_FILE, rows);
  return entry;
}

function updateLocalSubmission(id, updates) {
  const rows = readJsonFile(RUNTIME_DATA_FILE);
  const index = rows.findIndex((row) => String(row.id) === String(id));

  if (index === -1) {
    return null;
  }

  rows[index] = { ...rows[index], ...updates };
  writeJsonFile(RUNTIME_DATA_FILE, rows);
  return rows[index];
}

function getLocalSubmission(id) {
  return readLocalSubmissions().find((row) => String(row.id) === String(id)) || null;
}

module.exports = {
  readLocalSubmissions,
  appendLocalSubmission,
  updateLocalSubmission,
  getLocalSubmission,
};
