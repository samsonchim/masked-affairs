require('dotenv').config();

const fs = require('fs');
const express = require('express');
const multer = require('multer');
const path = require('path');
const {
  fetchSubmissions,
  fetchTickets,
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
  readLocalTickets,
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

function renderStatusPage({ title, subtitle, message, actionLabel, actionHref, theme = 'success' }) {
  const bg = theme === 'success' ? '#ecfdf5' : '#fef2f2';
  const text = theme === 'success' ? '#065f46' : '#991b1b';
  const buttonBg = theme === 'success' ? '#14b8a6' : '#ef4444';
  const buttonHover = theme === 'success' ? '#0f766e' : '#dc2626';

  const actionBtnHtml = actionLabel && actionHref
    ? `<a class="btn" href="${actionHref}">${actionLabel}</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; font-family: Inter, system-ui, sans-serif; background: linear-gradient(180deg, #030712 0%, #0f172a 100%); color: #e2e8f0; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .page { width: min(760px, 100%); background: rgba(15, 23, 42, 0.96); border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 28px; box-shadow: 0 30px 80px rgba(15, 23, 42, 0.35); padding: 36px; }
    .badge { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 22px; padding: 10px 16px; border-radius: 999px; background: ${bg}; color: ${text}; font-weight: 700; letter-spacing: 0.02em; }
    .title { font-size: clamp(2rem, 4vw, 2.75rem); margin: 0 0 16px; color: #fff; }
    .subtitle { margin: 0 0 26px; color: #cbd5e1; line-height: 1.6; }
    .message { margin: 0 0 28px; color: #e2e8f0; line-height: 1.75; background: rgba(148, 163, 184, 0.08); border: 1px solid rgba(148, 163, 184, 0.12); border-radius: 18px; padding: 18px; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 160px; padding: 14px 20px; border-radius: 14px; border: none; color: #fff; text-decoration: none; background: ${buttonBg}; transition: transform 0.2s ease, background 0.2s ease; }
    .btn:hover { transform: translateY(-1px); background: ${buttonHover}; }
    .secondary { background: rgba(228, 231, 239, 0.12); color: #e2e8f0; }
  </style>
</head>
<body>
  <section class="page">
    <span class="badge">${title}</span>
    <h1 class="title">${subtitle}</h1>
    <p class="message">${message || ''}</p>
    <div class="actions">
      ${actionBtnHtml}
      <a class="btn secondary" href="/">Return home</a>
    </div>
  </section>
</body>
</html>`;
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

async function loadTicketRows() {
  try {
    const rows = await fetchTickets();
    return { rows, source: 'supabase' };
  } catch (err) {
    console.error('⚠️ Supabase unavailable, using local tickets fallback:', err.message);
    return { rows: readLocalTickets(), source: 'local', error: err.message };
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

app.get('/api/tickets', async (req, res) => {
  try {
    const result = await Promise.race([
      loadTicketRows(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase took too long')), 5000)),
    ]).catch(() => ({ rows: readLocalTickets(), source: 'local', error: 'Supabase timeout - using cached data' }));

    const tickets = Array.isArray(result.rows)
      ? result.rows.filter((ticket) => String(ticket.status).toLowerCase() === 'paid')
      : [];

    return res.json({
      ok: true,
      tickets,
      source: result.source,
      warning: result.source === 'local' ? result.error : undefined,
    });
  } catch (err) {
    console.error('❌ Error fetching tickets:', err);
    return res.status(500).json({ error: 'Failed to load tickets' });
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
    imageName: 'pending-image.png',
    imageUrl: null,
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

    if (file) {
      console.log('📦 Uploading submission image to Vercel Blob', {
        originalName: file.originalname,
        size: file.size,
        source,
      });

      try {
        const blobUrl = await uploadImageToBlob(file.buffer, file.originalname, 'submissions');

        if (source === 'supabase') {
          savedEntry = await updateSubmission(savedEntry.id, { imageName: blobUrl });
        } else {
          savedEntry = updateLocalSubmission(savedEntry.id, { imageName: blobUrl }) || savedEntry;
        }

        console.log('✅ Image uploaded to Vercel Blob:', blobUrl);
      } catch (uploadErr) {
        console.error('❌ Image upload or update failed:', uploadErr.message);
      }
    }

    res.json({ ok: true, entry: savedEntry, source });

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
    requested_at: new Date().toISOString(),
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
      return res.status(500).send(renderStatusPage({
        title: 'Verification Failed',
        subtitle: 'Payment verification failed',
        message: 'We could not verify the ticket payment with Paystack. Please try again or contact support.',
        theme: 'error',
      }));
    }

    if (verifyData.data?.status !== 'success') {
      return res.send(renderStatusPage({
        title: 'Payment Pending',
        subtitle: 'Payment not completed',
        message: 'Your ticket payment did not complete successfully. Please check your Paystack payment page or try again.',
        theme: 'error',
      }));
    }

    const metadata = typeof verifyData.data.metadata === 'string'
      ? JSON.parse(verifyData.data.metadata || '{}')
      : verifyData.data.metadata || {};
    const ticketId = Number(metadata.ticketId);

    if (!ticketId) {
      return res.status(500).send(renderStatusPage({
        title: 'Ticket Error',
        subtitle: 'Ticket details missing',
        message: 'Your payment appears to have succeeded, but we could not find the ticket record. Please contact support with your reference.',
        theme: 'error',
      }));
    }

    try {
      await updateTicket(ticketId, {
        status: 'paid',
        confirmed_at: new Date().toISOString(),
        paystack_response: verifyData.data,
      });
    } catch (supabaseError) {
      console.error('⚠️ Supabase ticket update failed:', supabaseError.message);
      updateLocalTicket(ticketId, {
        status: 'paid',
        confirmed_at: new Date().toISOString(),
        paystack_response: verifyData.data,
      });
    }

    return res.send(renderStatusPage({
      title: 'Ticket Confirmed',
      subtitle: 'Payment successful',
      message: 'Your ticket purchase has been confirmed successfully.',
      theme: 'success',
    }));
  } catch (err) {
    console.error('❌ Ticket callback error:', err);
    return res.status(500).send(renderStatusPage({
      title: 'Verification Failed',
      subtitle: 'Ticket verification failed',
      message: 'There was an error verifying your ticket payment. Please try again or contact support.',
      theme: 'error',
    }));
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
      return res.status(500).send(renderStatusPage({
        title: 'Verification Failed',
        subtitle: 'Payment verification failed',
        message: 'We could not verify the vote payment with Paystack. Please try again or contact support.',
        theme: 'error',
      }));
    }

    if (verifyData.data?.status !== 'success') {
      return res.send(renderStatusPage({
        title: 'Payment Pending',
        subtitle: 'Payment not completed',
        message: 'Your vote payment did not complete successfully. Please try again or verify your transaction in Paystack.',
        actionLabel: 'Back to competitions',
        actionHref: '/competitions.html',
        theme: 'error',
      }));
    }

    const metadata = typeof verifyData.data.metadata === 'string'
      ? JSON.parse(verifyData.data.metadata || '{}')
      : verifyData.data.metadata || {};
    const participantId = Number(metadata.participantId);
    const quantity = Number(metadata.quantity) || 0;

    if (!participantId || quantity <= 0) {
      return res.status(500).send(renderStatusPage({
        title: 'Vote Error',
        subtitle: 'Vote details missing',
        message: 'Your payment succeeded, but we could not resolve the vote information. Please contact support with your payment reference.',
        actionLabel: 'Back to competitions',
        actionHref: '/competitions.html',
        theme: 'error',
      }));
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
        return res.status(500).send(renderStatusPage({
          title: 'Vote Error',
          subtitle: 'Vote could not be recorded',
          message: 'Your payment succeeded, but we could not record the vote. Please contact support or try again.',
          actionLabel: 'Back to competitions',
          actionHref: '/competitions.html',
          theme: 'error',
        }));
      }
      currentVotes = Number(localParticipant.votes) || 0;
      updateLocalSubmission(participantId, { votes: currentVotes + quantity });
    }

    return res.send(renderStatusPage({
      title: 'Vote Recorded',
      subtitle: 'Payment successful',
      message: 'Your vote has been recorded successfully. Thank you for supporting your favorite participant.',
      actionLabel: 'Back to competitions',
      actionHref: '/competitions.html',
      theme: 'success',
    }));
  } catch (err) {
    console.error('❌ Vote callback error:', err);
    return res.status(500).send(renderStatusPage({
      title: 'Verification Failed',
      subtitle: 'Vote verification failed',
      message: 'There was an error verifying your vote payment. Please try again or contact support.',
      actionLabel: 'Back to competitions',
      actionHref: '/competitions.html',
      theme: 'error',
    }));
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

app.get('/tickets', (req, res) => {
  res.redirect('/tickets.html');
});

app.get('/tickets.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'tickets.html'));
});

app.get('/masked-affairs-bg.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'masked-affairs-bg.png'));
});

app.use(express.static(path.join(__dirname), {
  index: false,
  dotfiles: 'ignore',
}));

module.exports = app;