const fs = require('fs');
const path = require('path');
const { put, del } = require('@vercel/blob');

const DATA_FILE = path.join(__dirname, '..', 'data', 'submissions.json');
const RUNTIME_DATA_FILE = path.join('/tmp', 'masked-submissions.json');
const TICKETS_DATA_FILE = path.join(__dirname, '..', 'data', 'tickets.json');
const RUNTIME_TICKETS_FILE = path.join('/tmp', 'masked-tickets.json');

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

function mergeRows(bundled, runtime) {
  const merged = new Map();
  [...bundled, ...runtime].forEach((row) => {
    if (row && row.id != null) merged.set(String(row.id), row);
  });
  return Array.from(merged.values());
}

/**
 * Upload an image to Vercel Blob
 * @param {Buffer} fileBuffer - File content buffer
 * @param {string} fileName - Original file name
 * @param {string} folder - Folder in blob storage (e.g., 'submissions', 'tickets')
 * @returns {Promise<string>} Public URL of the uploaded file
 */
async function uploadImageToBlob(fileBuffer, fileName, folder = 'uploads') {
  const token = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

  if (!token) {
    throw new Error('Vercel Blob token is not configured. Add BLOB_READ_WRITE_TOKEN to your Vercel env vars.');
  }

  try {
    const timestamp = Date.now();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const blobPath = `${folder}/${timestamp}-${safeFileName}`;

    const blob = await put(blobPath, fileBuffer, {
      access: 'public',
      token,
    });

    console.log(`✅ Image uploaded to Vercel Blob: ${blob.url}`);
    return blob.url;
  } catch (err) {
    console.error('Failed to upload image to Vercel Blob:', err.message);
    throw new Error(`Image upload failed: ${err.message}`);
  }
}

/**
 * Delete an image from Vercel Blob
 * @param {string} blobUrl - Full URL or blob path to delete
 */
async function deleteImageFromBlob(blobUrl) {
  try {
    await del(blobUrl);
    console.log(`✅ Image deleted from Vercel Blob: ${blobUrl}`);
  } catch (err) {
    console.error('Failed to delete image from Vercel Blob:', err.message);
  }
}

function readLocalSubmissions() {
  const bundled = readJsonFile(DATA_FILE);
  const runtime = readJsonFile(RUNTIME_DATA_FILE);
  return mergeRows(bundled, runtime).sort((a, b) => {
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

function readLocalTickets() {
  const bundled = readJsonFile(TICKETS_DATA_FILE);
  const runtime = readJsonFile(RUNTIME_TICKETS_FILE);
  return mergeRows(bundled, runtime).sort((a, b) => {
    const aTime = new Date(a.requestedAt || 0).getTime();
    const bTime = new Date(b.requestedAt || 0).getTime();
    return bTime - aTime;
  });
}

function appendLocalTicket(entry) {
  const rows = readJsonFile(RUNTIME_TICKETS_FILE);
  rows.push(entry);
  writeJsonFile(RUNTIME_TICKETS_FILE, rows);
  return entry;
}

function updateLocalTicket(id, updates) {
  const rows = readJsonFile(RUNTIME_TICKETS_FILE);
  const index = rows.findIndex((row) => String(row.id) === String(id));

  if (index === -1) {
    return null;
  }

  rows[index] = { ...rows[index], ...updates };
  writeJsonFile(RUNTIME_TICKETS_FILE, rows);
  return rows[index];
}

function getLocalTicket(id) {
  return readLocalTickets().find((row) => String(row.id) === String(id)) || null;
}

module.exports = {
  readLocalSubmissions,
  appendLocalSubmission,
  updateLocalSubmission,
  getLocalSubmission,
  readLocalTickets,
  appendLocalTicket,
  updateLocalTicket,
  getLocalTicket,
  uploadImageToBlob,
  deleteImageFromBlob,
};