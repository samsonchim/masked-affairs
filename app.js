require('dotenv').config(); // Load environment variables first

const fs = require('fs');
const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('❌ SUPABASE_URL and SUPABASE_KEY environment variables are required!');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use(express.json({ limit: '10mb' }));
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

// Serve static files (so GET / returns index.html)
app.use(express.static(path.join(__dirname)));

console.log('✅ Supabase initialized and ready');
console.log(`📝 Using project: ${SUPABASE_URL}`);

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_6d1f717865fb753a93eee779f8e183b2d97ea923';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_6afb7c2036136279fc527def931eab4bb37e630c';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

app.post('/api/submit', upload.single('image'), async (req, res) => {
  const payload = req.body || {};
  const file = req.file;

  // Basic validation
  if (!payload.name || !payload.category) {
    return res.status(400).json({ error: 'Missing required fields: name or category' });
  }

  try {
    const entry = {
      category: payload.category,
      name: payload.name,
      department: payload.department || null,
      level: payload.level || null,
      imageName: 'pending-image.png',
      reason: payload.reason || null,
      receivedAt: new Date().toISOString(),
    };

    // Save to Supabase first to get the row ID.
    const { data, error } = await supabase.from('submissions').insert([entry]).select();

    if (error) {
      console.error('❌ Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to save to Supabase' });
    }

    const savedEntry = data[0];
    const finalImageName = `${savedEntry.id}.png`;

    if (file) {
      const extension = path.extname(file.originalname).toLowerCase() || '.png';
      const imageName = `${savedEntry.id}${extension}`;
      const imagePath = path.join(UPLOAD_DIR, imageName);

      await fs.promises.writeFile(imagePath, file.buffer);

      const { data: updatedData, error: updateError } = await supabase
        .from('submissions')
        .update({ imageName })
        .eq('id', savedEntry.id)
        .select();

      if (updateError) {
        console.error('❌ Supabase update imageName error:', updateError);
      } else if (updatedData && updatedData[0]) {
        savedEntry.imageName = updatedData[0].imageName;
      } else {
        savedEntry.imageName = imageName;
      }
    } else {
      const { data: updatedData, error: updateError } = await supabase
        .from('submissions')
        .update({ imageName: finalImageName })
        .eq('id', savedEntry.id)
        .select();

      if (updateError) {
        console.error('❌ Supabase update imageName error:', updateError);
      } else if (updatedData && updatedData[0]) {
        savedEntry.imageName = updatedData[0].imageName;
      } else {
        savedEntry.imageName = finalImageName;
      }
    }

    console.log('✅ Entry saved:', savedEntry.name);
    return res.json({ ok: true, entry: savedEntry });
  } catch (err) {
    console.error('❌ Error saving submission:', err);
    return res.status(500).json({ error: 'Failed to save submission' });
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
    console.log('➡️ Paystack initialized reference:', paystackReference);

    return res.json({ ok: true, authorization_url: data.data.authorization_url, reference: paystackReference, amountNaira, quantity: normalizedQuantity });
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
    console.error('❌ Vote callback missing reference in query:', req.query);
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
    console.log('➡️ Paystack callback query:', req.query);

    let { verifyResponse, verifyData } = await verifyReference(reference);

    if ((!verifyResponse.ok || !verifyData.status) && rawTrxref && rawTrxref !== reference) {
      console.warn('⚠️ Paystack verify failed with reference, retrying trxref:', rawTrxref, verifyData);
      ({ verifyResponse, verifyData } = await verifyReference(rawTrxref));
    }

    if (!verifyResponse.ok || !verifyData.status) {
      console.error('❌ Paystack verify error:', verifyData);
      return res.status(500).send('Payment verification failed.');
    }

    if (verifyData.data?.status !== 'success') {
      console.warn('⚠️ Paystack payment not successful yet:', verifyData.data?.status);
      return res.send('<html><body style="font-family:Arial,sans-serif;padding:40px;background:#111;color:#fff;"><h2>Payment not completed</h2><p>Your payment could not be verified yet.</p><a href="/competitions.html" style="color:#d4af37;">Try again</a></body></html>');
    }

    const metadata = typeof verifyData.data.metadata === 'string'
      ? JSON.parse(verifyData.data.metadata || '{}')
      : verifyData.data.metadata || {};
    const participantId = Number(metadata.participantId);
    const quantity = Number(metadata.quantity) || 0;

    if (!participantId || quantity <= 0) {
      console.error('❌ Missing vote metadata on Paystack response:', metadata);
      return res.status(500).send('Payment succeeded but vote details are unavailable.');
    }

    const { data: participantData, error: participantError } = await supabase
      .from('submissions')
      .select('id, votes')
      .eq('id', participantId)
      .single();

    if (participantError) {
      console.error('❌ Vote update fetch error:', participantError);
      return res.status(500).send('Payment succeeded but your vote could not be recorded.');
    }

    const currentVotes = Number(participantData?.votes) || 0;
    const { error: updateError } = await supabase
      .from('submissions')
      .update({ votes: currentVotes + quantity })
      .eq('id', participantId);

    if (updateError) {
      console.error('❌ Vote update error:', updateError);
      return res.status(500).send('Payment succeeded but your vote could not be recorded.');
    }

    console.log('✅ Vote recorded:', { reference, participantId, quantity });

    return res.send('<html><body style="font-family:Arial,sans-serif;padding:40px;background:#111;color:#fff;"><h2>✅ Vote payment successful</h2><p>Your vote has been recorded.</p><a href="/competitions.html" style="color:#d4af37;">Back to competitions</a></body></html>');
  } catch (err) {
    console.error('❌ Vote callback error:', err);
    return res.status(500).send('Payment verification failed.');
  }
});

app.get('/api/competitions', async (req, res) => {
  const categoryFilter = req.query.category;

  try {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .order('receivedAt', { ascending: false });

    if (error) {
      console.error('❌ Supabase fetch error:', error);
      return res.status(500).json({ error: 'Failed to load competition entries' });
    }

    const categoriesMap = new Map();

    data.forEach((row) => {
      const category = row.category || 'Uncategorized';
      const votes = Number(row.votes) || 0;

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
        imageName: row.imageName,
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

    return res.json({ categories });
  } catch (err) {
    console.error('❌ Error fetching competitions:', err);
    return res.status(500).json({ error: 'Failed to load competition data' });
  }
});

module.exports = app;