const REQUEST_TIMEOUT_MS = 25000;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;

function buildHeaders(extraHeaders = {}, prefer) {
  const headers = {
    apikey: process.env.SUPABASE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  if (prefer) {
    headers.Prefer = prefer;
  }

  return headers;
}

async function supabaseRequest(path, options = {}) {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!baseUrl || !process.env.SUPABASE_KEY) {
    throw new Error('Supabase is not configured on the server.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
      method: options.method || 'GET',
      headers: buildHeaders(options.headers, options.prefer),
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      keepalive: true,
    });

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const message = data?.message || data?.hint || data?.error || `Supabase request failed (${response.status})`;
      throw new Error(message);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Supabase request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadStorageObject(bucket, objectPath, body, contentType) {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!baseUrl || !process.env.SUPABASE_KEY) {
    throw new Error('Supabase is not configured on the server.');
  }
  if (!bucket) {
    throw new Error('Supabase storage bucket is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(objectPath)}`,
      {
        method: 'PUT',
        headers: buildHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }),
        body,
        signal: controller.signal,
        keepalive: true,
      }
    );

    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { message: text };
      }
    }

    if (!response.ok) {
      const message = data?.message || data?.error || response.statusText || 'Supabase storage upload failed.';
      throw new Error(message);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Supabase storage upload timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadSubmissionImage(imageName, fileBuffer, contentType) {
  return uploadStorageObject(STORAGE_BUCKET, imageName, fileBuffer, contentType);
}

async function fetchSubmissions() {
  return supabaseRequest(
    'submissions?select=id,category,name,department,level,imageName,reason,votes,receivedAt'
  );
}

async function insertSubmission(entry) {
  const rows = await supabaseRequest('submissions', {
    method: 'POST',
    prefer: 'return=representation',
    body: entry,
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function updateSubmission(id, updates) {
  const rows = await supabaseRequest(`submissions?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: updates,
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function insertTicket(entry) {
  const rows = await supabaseRequest('tickets', {
    method: 'POST',
    prefer: 'return=representation',
    body: entry,
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function updateTicket(id, updates) {
  const rows = await supabaseRequest(`tickets?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: updates,
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function fetchSubmissionVotes(id) {
  const rows = await supabaseRequest(`submissions?id=eq.${id}&select=id,votes`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function pingSupabase() {
  await supabaseRequest('submissions?select=id&limit=1');
  return true;
}

module.exports = {
  fetchSubmissions,
  insertSubmission,
  updateSubmission,
  fetchSubmissionVotes,
  pingSupabase,
  uploadSubmissionImage,
  insertTicket,
  updateTicket,
};
