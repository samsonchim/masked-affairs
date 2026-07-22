require('dotenv').config();

const fs = require('fs');
const express = require('express');
const multer = require('multer');
const path = require('path');
const {
  fetchSubmissions,
  insertSubmission,
  updateSubmission,
  fetchSubmissionVotes,
  pingSupabase,
  listStorageObjects,
  insertTicket,
  updateTicket,
} = require('./lib/supabase-rest');
const {
  readLocalSubmissions,
  appendLocalSubmission,
  updateLocalSubmission,
  getLocalSubmission,
  appendLocalTicket,
  updateLocalTicket,
  getLocalTicket,
  uploadImageToBlob,
} = require('./lib/storage');

const app = express();
const IS_VERCEL = process.env.VERCEL === '1';
const UPLOAD_DIR = IS_VERCEL
  ? path.join('/tmp', 'uploads')
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_6d1f717865fb753a93eee779f8e183b2d97ea923';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const SUPABASE_STORAGE_PUBLIC_URL = process.env.SUPABASE_URL
  ? `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${process.env.SUPABASE_STORAGE_BUCKET}`
  : null;
const TICKET_PRICES = {
  regular: 3000,
  vip: 7000,
  table4: 50000,
  table6: 70000,
};

app.use(express.json({ limit: '10mb' }));

function buildCategories(rows, categoryFilter) {
  const categoriesMap = new Map();

  rows.forEach((row) => {
    const category = row.category || 'Uncategorized';
    const votes = Number(row.votes) || 0;
    const imageName = row.imageName || 'pending-image.png';
    let imageUrl = row.imageUrl || '';

    if (!imageUrl) {
      if (String(imageName).startsWith('http://') || String(imageName).startsWith('https://')) {
        imageUrl = imageName;
      } else if (SUPABASE_STORAGE_PUBLIC_URL && imageName !== 'pending-image.png') {
        imageUrl = `${SUPABASE_STORAGE_PUBLIC_URL}/${encodeURIComponent(imageName)}`;
      } else {
        imageUrl = `/uploads/${imageName}`;
      }
    }

    if (!categoriesMap.has(category)) {
      categoriesMap.set(category, {
        name: category,
        participants: [],
        totalVotes: 0,
      });
    }

    const categoryEntry = categoriesMap.get(category);
    categoryEntry.participants.push({
      id: row.id,
      name: row.name,
      department: row.department,
      level: row.level,
      imageName,
      imageUrl,
      reason: row.reason,
      votes,
      receivedAt: row.receivedAt,
    });
    categoryEntry.totalVotes += votes;
  });

  let categories = Array.from(categoriesMap.values()).map((category) => ({
    ...category,
    totalParticipants: category.participants.length,
  }));

  categories.sort((a, b) => b.totalParticipants - a.totalParticipants);

  if (categoryFilter) {
    categories = categories.filter((category) => category.name === categoryFilter);
  }

  return categories;
}

async function loadSubmissionRows() {
  try {
    const rows = await fetchSubmissions();
    return { rows, source: 'supabase' };
  } catch (err) {
    console.error('⚠️ Supabase unavailable, using local submissions fallback:', err.message);
    return { rows: readLocalSubmissions(), source: 'local', error: err.message };
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    vercel: IS_VERCEL,
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
  });
});

app.get('/api/health/db', async (req, res) => {
  try {
    await Promise.race([
      pingSupabase(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 3000)
      ),
    ]);
    return res.json({ ok: true, db: 'connected' });
  } catch (err) {
    return res.status(503).json({ ok: false, db: 'disconnected', error: err.message });
  }
});

app.get('/api/competitions', async (req, res) => {
  const categoryFilter = req.query.category;

  try {
    // Use a timeout race: if Supabase takes >5 seconds, return local data instead
    const result = await Promise.race([
      loadSubmissionRows(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Supabase took too long')), 5000)
      ),
    ]).catch(() => ({
      rows: readLocalSubmissions(),
      source: 'local',
      error: 'Supabase timeout - using cached data',
    }));

    const categories = buildCategories(result.rows, categoryFilter);

    return res.json({
      categories,
      source: result.source,
      warning: result.source === 'local' ? result.error : undefined,
    });
  } catch (err) {
    console.error('❌ Error fetching competitions:', err);
    return res.status(500).json({ error: 'Failed to load competition data' });
  }
});

// Debug: list objects in Supabase storage bucket (requires SUPABASE configured)
app.get('/api/storage/list', async (req, res) => {
  const prefix = req.query.prefix || '';
  try {
    const list = await listStorageObjects(process.env.SUPABASE_STORAGE_BUCKET, prefix);
    return res.json({ ok: true, items: list });
  } catch (err) {
    console.error('❌ Storage list error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/submit', upload.single('image'), async (req, res) => {
  const payload = req.body || {};
  const file = req.file;

  if (!payload.name || !payload.category) {
    return res.status(400).json({ error: 'Missing required fields: name or category' });
  }

  const baseEntry = {
    category: payload.category,
    name: payload.name,
    department: payload.department || null,
    level: payload.level || null,
    imageUrl: null, // Will be set after upload
    reason: payload.reason || null,
    receivedAt: new Date().toISOString(),
    votes: 0,
  };

  try {
    let savedEntry;
    let source = 'supabase';

    try {
      savedEntry = await insertSubmission(baseEntry);
    } catch (supabaseError) {
      console.error('⚠️ Supabase insert failed, saving locally:', supabaseError.message);
      source = 'local';
      savedEntry = appendLocalSubmission({
        ...baseEntry,
        id: Date.now(),
      });
    }

    // Always save the submission first, then handle image upload asynchronously.
    res.json({ ok: true, entry: savedEntry, source });

    (async () => {
      try {
        if (file) {
          console.log('📦 Uploading submission image to Vercel Blob', {
            originalName: file.originalname,
            size: file.size,
            source,
          });

          const blobUrl = await uploadImageToBlob(file.buffer, file.originalname, 'submissions');

          if (source === 'supabase') {
            await updateSubmission(savedEntry.id, { imageUrl: blobUrl });
          } else {
            updateLocalSubmission(savedEntry.id, { imageUrl: blobUrl });
          }

          console.log('✅ Image uploaded to Vercel Blob:', blobUrl);
        }

        console.log('✅ Entry saved:', savedEntry.name, `(${source})`);
      } catch (bgErr) {
        console.error('❌ Background processing error:', bgErr.message);
        if (file && source === 'supabase') {
          try {
            await updateSubmission(savedEntry.id, { imageUrl: null, imageName: file.originalname });
          } catch (updateErr) {
            console.error('⚠️ Failed to record upload error on submission:', updateErr.message);
          }
        }
      }
    })();
  } catch (err) {
    console.error('❌ Error saving submission:', err);
    return res.status(500).json({ error: 'Failed to save submission' });
  }
});

app.post('/api/tickets/initiate', async (req, res) => {
  const { name, email, phone, ticketType, quantity } = req.body || {};
  const normalizedQuantity = Math.max(1, Number(quantity) || 1);
  const ticketPrice = TICKET_PRICES[ticketType];

  if (!name || !email || !phone || !ticketType || !ticketPrice) {
    return res.status(400).json({ error: 'Please complete all ticket fields.' });
  }

  const amountNaira = ticketPrice * normalizedQuantity;
  const reference = `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const callbackUrl = `${APP_URL}/api/tickets/callback`;

  const ticketEntry = {
    name,
    email,
    phone,
    ticket_type: ticketType,
    quantity: normalizedQuantity,
    amount: amountNaira,
    status: 'pending',
    reference,
    requestedAt: new Date().toISOString(),
  };

  try {
    let savedTicket;
    let source = 'supabase';

    try {
      savedTicket = await insertTicket(ticketEntry);
    } catch (supabaseError) {
      console.error('⚠️ Supabase ticket insert failed, saving locally:', supabaseError.message);
      source = 'local';
      savedTicket = appendLocalTicket({
        ...ticketEntry,
        id: Date.now(),
      });
    }

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amountNaira * 100,
        currency: 'NGN',
        reference,
        callback_url: callbackUrl,
        metadata: {
          ticketId: savedTicket.id,
          source,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.status) {
      console.error('❌ Paystack ticket init error:', data);
      return res.status(500).json({ error: 'Unable to start ticket payment.' });
    }

    const paystackReference = data.data?.reference || reference;
    return res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      reference: paystackReference,
      amountNaira,
      quantity: normalizedQuantity,
      ticketId: savedTicket.id,
      source,
    });
  } catch (err) {
    console.error('❌ Ticket initiation error:', err);
    return res.status(500).json({ error: 'Unable to start ticket payment.' });
  }
});

app.get('/api/tickets/callback', async (req, res) => {
  const rawReference = Array.isArray(req.query.reference)
    ? req.query.reference[0]
    : req.query.reference;
  const rawTrxref = Array.isArray(req.query.trxref) ? req.query.trxref[0] : req.query.trxref;
  const reference = rawReference || rawTrxref;

  if (!reference) {
    return res.status(400).send('Missing payment reference.');
  }

  const verifyReference = async (ref) => {
    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const verifyData = await verifyResponse.json();
    return { verifyResponse, verifyData };
  };

  try {
    let { verifyResponse, verifyData } = await verifyReference(reference);

    if ((!verifyResponse.ok || !verifyData.status) && rawTrxref && rawTrxref !== reference) {
      ({ verifyResponse, verifyData } = await verifyReference(rawTrxref));
    }

    if (!verifyResponse.ok || !verifyData.status) {
      return res.status(500).send('Payment verification failed.');
    }

    if (verifyData.data?.status !== 'success') {
      return res.send('<html><body style="font-family:Arial,sans-serif;padding:40px;background:#111;color:#fff;"><h2>Payment not completed</h2><p>Your payment could not be verified yet.</p><a href="/" style="color:#d4af37;">Return home</a></body></html>');
    }

    const metadata = typeof verifyData.data.metadata === 'string'
      ? JSON.parse(verifyData.data.metadata || '{}')
      : verifyData.data.metadata || {};
    const ticketId = Number(metadata.ticketId);

    if (!ticketId) {
      return res.status(500).send('Payment succeeded but ticket details are unavailable.');
    }

    try {
      await updateTicket(ticketId, {
        status: 'paid',
        confirmedAt: new Date().toISOString(),
        paystack_response: verifyData.data,
      });
    } catch (supabaseError) {
      console.error('⚠️ Supabase ticket update failed:', supabaseError.message);
      updateLocalTicket(ticketId, {
        status: 'paid',
        confirmedAt: new Date().toISOString(),
        paystack_response: verifyData.data,
      });
    }

    return res.send('<html><body style="font-family:Arial,sans-serif;padding:40px;background:#111;color:#fff;"><h2>✅ Ticket payment successful</h2><p>Your ticket purchase has been confirmed.</p><a href="/" style="color:#d4af37;">Return home</a></body></html>');
  } catch (err) {
    console.error('❌ Ticket callback error:', err);
    return res.status(500).send('Payment verification failed.');
  }
});

app.post('/api/vote/initiate', async (req, res) => {
  const { participantId, quantity, email } = req.body || {};

  if (!participantId || !email) {
    return res.status(400).json({ error: 'Participant and email are required.' });
  }

  const normalizedQuantity = Math.max(1, Number(quantity) || 1);
  const amountNaira = normalizedQuantity * 100;
  const reference = `vote-${participantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const callbackUrl = `${APP_URL}/api/vote/callback`;

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amountNaira * 100,
        currency: 'NGN',
        reference,
        callback_url: callbackUrl,
        metadata: {
          participantId,
          quantity: normalizedQuantity,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.status) {
      console.error('❌ Paystack init error:', data);
      return res.status(500).json({ error: 'Unable to start payment.' });
    }

    const paystackReference = data.data?.reference || reference;
    return res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      reference: paystackReference,
      amountNaira,
      quantity: normalizedQuantity,
    });
  } catch (err) {
    console.error('❌ Vote init error:', err);
    return res.status(500).json({ error: 'Unable to start payment.' });
  }
});

app.get('/api/vote/callback', async (req, res) => {
  const rawReference = Array.isArray(req.query.reference)
    ? req.query.reference[0]
    : req.query.reference;
  const rawTrxref = Array.isArray(req.query.trxref) ? req.query.trxref[0] : req.query.trxref;
  const reference = rawReference || rawTrxref;

  if (!reference) {
    return res.status(400).send('Missing payment reference.');
  }

  const verifyReference = async (ref) => {
    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const verifyData = await verifyResponse.json();
    return { verifyResponse, verifyData };
  };

  try {
    let { verifyResponse, verifyData } = await verifyReference(reference);

    if ((!verifyResponse.ok || !verifyData.status) && rawTrxref && rawTrxref !== reference) {
      ({ verifyResponse, verifyData } = await verifyReference(rawTrxref));
    }

    if (!verifyResponse.ok || !verifyData.status) {
      return res.status(500).send('Payment verification failed.');
    }

    if (verifyData.data?.status !== 'success') {
      return res.send('<html><body style="font-family:Arial,sans-serif;padding:40px;background:#111;color:#fff;"><h2>Payment not completed</h2><p>Your payment could not be verified yet.</p><a href="/competitions.html" style="color:#d4af37;">Try again</a></body></html>');
    }

    const metadata = typeof verifyData.data.metadata === 'string'
      ? JSON.parse(verifyData.data.metadata || '{}')
      : verifyData.data.metadata || {};
    const participantId = Number(metadata.participantId);
    const quantity = Number(metadata.quantity) || 0;

    if (!participantId || quantity <= 0) {
      return res.status(500).send('Payment succeeded but vote details are unavailable.');
    }

    let currentVotes = 0;

    try {
      const participantData = await fetchSubmissionVotes(participantId);
      if (!participantData) {
        throw new Error('Participant not found in Supabase');
      }
      currentVotes = Number(participantData.votes) || 0;
      await updateSubmission(participantId, { votes: currentVotes + quantity });
    } catch (supabaseError) {
      const localParticipant = getLocalSubmission(participantId);
      if (!localParticipant) {
        return res.status(500).send('Payment succeeded but your vote could not be recorded.');
      }
      currentVotes = Number(localParticipant.votes) || 0;
      updateLocalSubmission(participantId, { votes: currentVotes + quantity });
    }

    return res.send('<html><body style="font-family:Arial,sans-serif;padding:40px;background:#111;color:#fff;"><h2>✅ Vote payment successful</h2><p>Your vote has been recorded.</p><a href="/competitions.html" style="color:#d4af37;">Back to competitions</a></body></html>');
  } catch (err) {
    console.error('❌ Vote callback error:', err);
    return res.status(500).send('Payment verification failed.');
  }
});

app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/competitions', (req, res) => {
  res.redirect('/competitions.html');
});

app.get('/competitions.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'competitions.html'));
});

app.get('/masked-affairs-bg.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'masked-affairs-bg.png'));
});

app.use(express.static(path.join(__dirname), {
  index: false,
  dotfiles: 'ignore',
}));

module.exports = app;