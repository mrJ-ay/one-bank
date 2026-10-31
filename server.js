/* =========================================================
   ONE BANK (원뱅크) — Express Server
   - ONEID 통합 가상 인터넷 뱅킹 & 실시간 계좌 송금 플랫폼
   ========================================================= */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initSchema,
  isDbAvailable,
  getOrCreateAccount,
  searchRecipient,
  transferFunds,
  claimParkingInterest,
  getTransactions
} from './lib/db.js';
import { authMiddleware, ONEID_URL, CLIENT_ID } from './lib/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5507;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Healthcheck
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'one-bank',
    db: isDbAvailable(),
    time: new Date().toISOString()
  });
});

// 2. Public Config
app.get('/api/config', (req, res) => {
  res.json({
    oneIdUrl: ONEID_URL,
    clientId: CLIENT_ID,
    ecosystem: {
      slotsUrl: process.env.SLOTS_URL || 'https://vegas-slots-2izy.onrender.com',
      jarketUrl: process.env.JARKET_URL || 'https://jarket.onrender.com',
      gtbUrl: process.env.GTB_URL || 'https://grand-theft-bicycle.onrender.com',
      nexusUrl: process.env.NEXUS_URL || 'https://nexus-exchange.onrender.com',
      atelierUrl: process.env.ATELIER_URL || 'https://atelier-j.vercel.app'
    }
  });
});

// 3. 내 계좌 & 잔고 조회
app.get('/api/account/me', authMiddleware, async (req, res) => {
  try {
    const acc = await getOrCreateAccount(req.user.id, req.user.name);
    res.json({ ok: true, account: acc });
  } catch (err) {
    console.error('[/api/account/me Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. 송금 대상자 실시간 검색 (계좌번호 또는 닉네임)
app.get('/api/account/search', authMiddleware, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: '검색어를 입력하세요.' });

    const recipient = await searchRecipient(query);
    if (!recipient) {
      return res.json({ exists: false, message: '일치하는 계좌나 닉네임이 없습니다.' });
    }

    if (recipient.playerId === req.user.id) {
      return res.json({ exists: false, isSelf: true, message: '본인 계좌로는 송금할 수 없습니다.' });
    }

    res.json({
      exists: true,
      recipient: {
        name: recipient.name,
        accountNo: recipient.accountNo,
        accountName: recipient.accountName
      }
    });
  } catch (err) {
    console.error('[/api/account/search Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 5. 실시간 계좌 송금 (Transfer)
app.post('/api/account/transfer', authMiddleware, async (req, res) => {
  try {
    const { toIdentifier, amount, senderMemo, recipientMemo } = req.body;
    if (!toIdentifier) return res.status(400).json({ error: '받는 분의 계좌번호나 닉네임을 입력하세요.' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: '올바른 금액을 입력하세요.' });

    const receipt = await transferFunds({
      fromPlayerId: req.user.id,
      toIdentifier,
      amount,
      senderMemo,
      recipientMemo
    });

    res.json({ ok: true, receipt });
  } catch (err) {
    console.error('[/api/account/transfer Error]:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// 6. 파킹통장 일일 이자 받기
app.post('/api/account/interest', authMiddleware, async (req, res) => {
  try {
    const result = await claimParkingInterest(req.user.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[/api/account/interest Error]:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// 7. 거래 내역 조회 (페이징 & 필터)
app.get('/api/account/ledger', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const type = req.query.type || 'all';

    const transactions = await getTransactions(req.user.id, { limit, offset, type });
    res.json({ ok: true, transactions, limit, offset });
  } catch (err) {
    console.error('[/api/account/ledger Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// SPA Fallback & Callback redirect
app.get('/callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
async function start() {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`🏦 ONE BANK Server running at http://localhost:${PORT}`);
  });
}

start();
