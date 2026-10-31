/* =========================================================
   ONE BANK (원뱅크) — Client Application Logic
   ========================================================= */

// Audio Synthesizer (Web Audio API)
class BankAudio {
  constructor() {
    this.ctx = null;
  }
  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) this.ctx = new AudioContext();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }
  playChime() {
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    
    // Tone 1: E5 (659.25Hz)
    const osc1 = this.ctx.createOscillator();
    const g1 = this.ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    g1.gain.setValueAtTime(0.18, now);
    g1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(g1);
    g1.connect(this.ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Tone 2: B5 (987.77Hz)
    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(987.77, now + 0.12);
    g2.gain.setValueAtTime(0.22, now + 0.12);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(g2);
    g2.connect(this.ctx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.6);
  }
  playCoin() {
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(987.77, now);
    osc.frequency.exponentialRampToValueAtTime(1318.51, now + 0.15);
    g.gain.setValueAtTime(0.2, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.45);
  }
  playTap() {
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.05);
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }
}

const audio = new BankAudio();

// State
const state = {
  authToken: localStorage.getItem('oneid_token') || '',
  config: null,
  account: null,
  hideBalance: false,
  verifiedRecipient: null,
  ledgerType: 'all',
  ledgerOffset: 0,
  hasMoreLedger: false
};

// =========================================================
// 1. Toast Notification Helper
// =========================================================
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
  }, 2600);
}

// =========================================================
// 2. PKCE SSO Helpers
// =========================================================
function base64UrlEncode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest('SHA-256', data);
}

function generateRandomString(length) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const values = new Uint32Array(length);
  window.crypto.getRandomValues(values);
  for (let i = 0; i < length; i++) {
    result += charset[values[i] % charset.length];
  }
  return result;
}

async function startOneIdLogin() {
  if (!state.config) return;
  const verifier = generateRandomString(64);
  const challenge = base64UrlEncode(await sha256(verifier));
  const stateVal = generateRandomString(32);

  sessionStorage.setItem('onebank_code_verifier', verifier);
  sessionStorage.setItem('onebank_auth_state', stateVal);

  const redirectUri = `${window.location.origin}/callback`;
  const authUrl = `${state.config.oneIdUrl}/oauth/authorize?client_id=${state.config.clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=${stateVal}`;

  window.location.href = authUrl;
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const stateVal = params.get('state');

  if (code && stateVal) {
    const savedState = sessionStorage.getItem('onebank_auth_state');
    const verifier = sessionStorage.getItem('onebank_code_verifier');

    if (stateVal !== savedState) {
      console.warn('OAuth state mismatch. Guest fallback applied.');
      return;
    }

    try {
      const redirectUri = `${window.location.origin}/callback`;
      const res = await fetch(`${state.config.oneIdUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: state.config.clientId,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier
        })
      });

      if (res.ok) {
        const data = await res.json();
        state.authToken = data.access_token;
        localStorage.setItem('oneid_token', state.authToken);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (e) {
      console.error('Failed to exchange token:', e);
    }
  }
}

// Ensure Token (Guest fallback)
function ensureAuthToken() {
  if (!state.authToken) {
    let guestId = localStorage.getItem('onebank_guest_id');
    if (!guestId) {
      guestId = 'guest_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('onebank_guest_id', guestId);
    }
    state.authToken = `${guestId}_익명의고객`;
    localStorage.setItem('oneid_token', state.authToken);
  }
}

// =========================================================
// 3. API Calls & Data Sync
// =========================================================
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
    if (state.config.ecosystem) {
      const eco = state.config.ecosystem;
      if (eco.slotsUrl) document.getElementById('link-slots').href = eco.slotsUrl;
      if (eco.gtbUrl) document.getElementById('link-gtb').href = eco.gtbUrl;
      if (eco.jarketUrl) document.getElementById('link-jarket').href = eco.jarketUrl;
      if (eco.nexusUrl) document.getElementById('link-nexus').href = eco.nexusUrl;
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

async function fetchAccount() {
  try {
    const res = await fetch('/api/account/me', {
      headers: { Authorization: `Bearer ${state.authToken}` }
    });

    if (res.status === 401) {
      // Token expired
      localStorage.removeItem('oneid_token');
      state.authToken = '';
      ensureAuthToken();
      return fetchAccount();
    }

    if (!res.ok) throw new Error('계좌 조회 실패');
    const data = await res.json();
    state.account = data.account;
    renderAccountUI();
  } catch (e) {
    console.error('fetchAccount Error:', e);
    showToast('계좌 정보를 불러오는 중 오류가 발생했습니다.');
  }
}

async function fetchLedger(reset = false) {
  if (reset) {
    state.ledgerOffset = 0;
    document.getElementById('ledger-list').innerHTML = '';
  }

  const loadingEl = document.getElementById('ledger-loading');
  const emptyEl = document.getElementById('ledger-empty');
  const loadMoreBtn = document.getElementById('btn-load-more');

  loadingEl.classList.remove('hidden');

  try {
    const url = `/api/account/ledger?type=${state.ledgerType}&offset=${state.ledgerOffset}&limit=30`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${state.authToken}` }
    });
    const data = await res.json();
    loadingEl.classList.add('hidden');

    if (data.ok) {
      const txs = data.transactions;
      if (reset && txs.length === 0) {
        emptyEl.classList.remove('hidden');
        loadMoreBtn.classList.add('hidden');
        return;
      }

      emptyEl.classList.add('hidden');
      renderTransactions(txs);

      state.ledgerOffset += txs.length;
      if (txs.length >= 30) {
        loadMoreBtn.classList.remove('hidden');
      } else {
        loadMoreBtn.classList.add('hidden');
      }
    }
  } catch (e) {
    loadingEl.classList.add('hidden');
    console.error('fetchLedger Error:', e);
  }
}

// =========================================================
// 4. UI Rendering
// =========================================================
function renderAccountUI() {
  if (!state.account) return;
  const acc = state.account;

  // Header & Greeting
  document.getElementById('greeting-name').innerText = acc.name;
  document.getElementById('user-name').innerText = acc.name;

  if (state.authToken.startsWith('guest_')) {
    document.getElementById('btn-login').classList.remove('hidden');
    document.getElementById('user-pill').classList.add('hidden');
  } else {
    document.getElementById('btn-login').classList.add('hidden');
    document.getElementById('user-pill').classList.remove('hidden');
  }

  // Bank Card
  document.getElementById('card-account-name').innerText = acc.accountName;
  document.getElementById('card-account-no').innerText = acc.accountNo;
  document.getElementById('share-acc-text').innerText = acc.accountNo;
  document.getElementById('share-name-text').innerText = `${acc.name} 님`;

  // Balance
  if (state.hideBalance) {
    document.getElementById('card-balance').innerText = '••••••';
  } else {
    document.getElementById('card-balance').innerText = acc.balance.toLocaleString();
  }

  document.getElementById('card-credit').innerText = acc.credit.toLocaleString();
  document.getElementById('transfer-avail-bal').innerText = `₩ ${acc.balance.toLocaleString()}`;

  // Daily Interest Card
  const int = acc.dailyInterest;
  const claimBtn = document.getElementById('btn-claim-interest');
  const descEl = document.getElementById('interest-desc');

  if (int.canClaim && int.amount > 0) {
    claimBtn.disabled = false;
    claimBtn.innerText = `+₩ ${int.amount.toLocaleString()} 받기`;
    descEl.innerHTML = `오늘 쌓인 파킹통장 이자: <b>+₩ ${int.amount.toLocaleString()}</b> (연 3.5% 일할 혜택!)`;
  } else {
    claimBtn.disabled = true;
    claimBtn.innerText = '수령 완료';
    descEl.innerText = int.reason || '오늘의 이자를 이미 모두 수령하셨습니다.';
  }
}

function renderTransactions(txs) {
  const listEl = document.getElementById('ledger-list');

  txs.forEach(tx => {
    const li = document.createElement('li');
    li.className = 'ledger-item';

    const isDeposit = tx.delta > 0;
    const sign = isDeposit ? '+' : '';
    const amtClass = isDeposit ? 'deposit' : 'withdraw';

    const dateStr = formatDateTime(tx.at);

    li.innerHTML = `
      <div class="item-left">
        <div class="item-icon-box">${tx.icon || '💳'}</div>
        <div class="item-texts">
          <div class="item-title-row">
            <span class="item-cat-badge badge-${tx.category}">${tx.category}</span>
            <span class="item-title">${escapeHtml(tx.title)}</span>
          </div>
          <span class="item-date">${dateStr}</span>
        </div>
      </div>
      <div class="item-right">
        <span class="item-amount ${amtClass}">${sign}₩ ${Math.abs(tx.delta).toLocaleString()}</span>
        <span class="item-balance-after">잔액 ₩ ${tx.balanceAfter.toLocaleString()}</span>
      </div>
    `;

    listEl.appendChild(li);
  });
}

function formatDateTime(isoString) {
  const d = new Date(isoString);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}.${day} ${h}:${min}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =========================================================
// 5. Transfer Actions & Verification
// =========================================================
let searchDebounce = null;

async function doSearchRecipient() {
  const val = document.getElementById('input-recipient').value.trim();
  const resBox = document.getElementById('recipient-result');
  const errBox = document.getElementById('recipient-error');
  const submitBtn = document.getElementById('btn-submit-transfer');

  if (!val) {
    resBox.classList.add('hidden');
    errBox.classList.add('hidden');
    state.verifiedRecipient = null;
    validateTransferForm();
    return;
  }

  try {
    const res = await fetch(`/api/account/search?q=${encodeURIComponent(val)}`, {
      headers: { Authorization: `Bearer ${state.authToken}` }
    });
    const data = await res.json();

    if (data.exists && data.recipient) {
      state.verifiedRecipient = data.recipient;
      resBox.classList.remove('hidden');
      errBox.classList.add('hidden');
      document.getElementById('res-name').innerText = data.recipient.name;
      document.getElementById('res-acc').innerText = `${data.recipient.accountNo} (${data.recipient.accountName})`;
      audio.playTap();
    } else {
      state.verifiedRecipient = null;
      resBox.classList.add('hidden');
      errBox.classList.remove('hidden');
      errBox.innerText = data.message || '일치하는 계좌나 닉네임이 없습니다.';
    }
  } catch (e) {
    state.verifiedRecipient = null;
    resBox.classList.add('hidden');
    errBox.classList.remove('hidden');
    errBox.innerText = '수취인 확인 중 오류가 발생했습니다.';
  }

  validateTransferForm();
}

function validateTransferForm() {
  const amt = Number(document.getElementById('input-amount').value);
  const submitBtn = document.getElementById('btn-submit-transfer');

  const isValid = state.verifiedRecipient &&
    amt > 0 &&
    state.account &&
    amt <= state.account.balance;

  submitBtn.disabled = !isValid;
}

async function executeTransfer() {
  if (!state.verifiedRecipient) return;
  const amount = Number(document.getElementById('input-amount').value);
  const memo = document.getElementById('input-memo').value.trim();

  if (amount <= 0 || amount > state.account.balance) {
    showToast('송금 금액을 확인해 주세요.');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-transfer');
  submitBtn.disabled = true;
  submitBtn.innerText = '송금 처리 중...';

  try {
    const res = await fetch('/api/account/transfer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.authToken}`
      },
      body: JSON.stringify({
        toIdentifier: state.verifiedRecipient.accountNo,
        amount,
        senderMemo: memo,
        recipientMemo: memo
      })
    });

    const data = await res.json();
    submitBtn.innerText = '송금하기';

    if (data.ok && data.receipt) {
      const r = data.receipt;
      audio.playChime();

      // Close transfer modal
      document.getElementById('modal-transfer').classList.add('hidden');

      // Populate & open receipt modal
      document.getElementById('rcpt-amount').innerText = `₩ ${r.amount.toLocaleString()}`;
      document.getElementById('rcpt-to').innerText = `${r.toName} (${r.toAccountNo})`;
      document.getElementById('rcpt-from').innerText = r.fromName;
      document.getElementById('rcpt-time').innerText = new Date(r.timestamp).toLocaleString();
      document.getElementById('rcpt-txid').innerText = r.txId;
      document.getElementById('rcpt-balance').innerText = `₩ ${r.balanceAfter.toLocaleString()}`;

      document.getElementById('modal-receipt').classList.remove('hidden');

      // Refresh account and ledger
      await fetchAccount();
      await fetchLedger(true);
    } else {
      showToast(data.error || '송금에 실패했습니다.');
      submitBtn.disabled = false;
    }
  } catch (e) {
    submitBtn.innerText = '송금하기';
    submitBtn.disabled = false;
    showToast('송금 요청 중 오류가 발생했습니다.');
  }
}

// =========================================================
// 6. Event Handlers
// =========================================================
function setupEventHandlers() {
  // Login / Logout
  document.getElementById('btn-login').addEventListener('click', () => {
    audio.playTap();
    startOneIdLogin();
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    audio.playTap();
    localStorage.removeItem('oneid_token');
    window.location.reload();
  });

  // Refresh
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    audio.playTap();
    await fetchAccount();
    await fetchLedger(true);
    showToast('잔고 및 거래 내역이 최신으로 갱신되었습니다.');
  });

  // Copy Account Number
  const copyAccHandler = () => {
    if (!state.account) return;
    navigator.clipboard.writeText(state.account.accountNo).then(() => {
      audio.playTap();
      showToast(`계좌번호 [${state.account.accountNo}]가 복사되었습니다!`);
    }).catch(() => {
      showToast(`계좌번호: ${state.account.accountNo}`);
    });
  };
  document.getElementById('btn-copy-acc').addEventListener('click', copyAccHandler);
  document.getElementById('btn-copy-share').addEventListener('click', copyAccHandler);

  // Toggle Balance Visibility
  document.getElementById('btn-toggle-eye').addEventListener('click', () => {
    audio.playTap();
    state.hideBalance = !state.hideBalance;
    renderAccountUI();
  });

  // Claim Daily Parking Interest
  document.getElementById('btn-claim-interest').addEventListener('click', async () => {
    const btn = document.getElementById('btn-claim-interest');
    btn.disabled = true;
    btn.innerText = '수령 중...';

    try {
      const res = await fetch('/api/account/interest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.authToken}` }
      });
      const data = await res.json();
      if (data.ok) {
        audio.playCoin();
        showToast(`💰 일일 파킹이자 +₩ ${data.amount.toLocaleString()} 입금 완료!`);
        await fetchAccount();
        await fetchLedger(true);
      } else {
        showToast(data.error || '이자 수령 실패');
        renderAccountUI();
      }
    } catch (e) {
      showToast('이자 수령 중 오류가 발생했습니다.');
      renderAccountUI();
    }
  });

  // Open Transfer Modal
  document.getElementById('btn-open-transfer').addEventListener('click', () => {
    audio.playTap();
    document.getElementById('input-recipient').value = '';
    document.getElementById('input-amount').value = '';
    document.getElementById('input-memo').value = '';
    document.getElementById('recipient-result').classList.add('hidden');
    document.getElementById('recipient-error').classList.add('hidden');
    state.verifiedRecipient = null;
    validateTransferForm();
    document.getElementById('modal-transfer').classList.remove('hidden');
    document.getElementById('input-recipient').focus();
  });

  // Close Transfer Modal
  document.getElementById('btn-close-transfer').addEventListener('click', () => {
    audio.playTap();
    document.getElementById('modal-transfer').classList.add('hidden');
  });

  // Recipient input typing debounce
  document.getElementById('input-recipient').addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearchRecipient, 450);
  });

  document.getElementById('btn-search-recipient').addEventListener('click', () => {
    audio.playTap();
    doSearchRecipient();
  });

  // Amount input event
  document.getElementById('input-amount').addEventListener('input', validateTransferForm);

  // Quick Amount Buttons
  document.querySelectorAll('.btn-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      audio.playTap();
      const input = document.getElementById('input-amount');
      const cur = Number(input.value) || 0;
      if (btn.id === 'btn-all-in') {
        input.value = state.account ? state.account.balance : 0;
      } else {
        const add = Number(btn.getAttribute('data-add')) || 0;
        input.value = cur + add;
      }
      validateTransferForm();
    });
  });

  // Submit Transfer
  document.getElementById('btn-submit-transfer').addEventListener('click', executeTransfer);

  // Close Receipt Modal
  document.getElementById('btn-close-receipt').addEventListener('click', () => {
    audio.playTap();
    document.getElementById('modal-receipt').classList.add('hidden');
  });

  // Open Share Modal
  document.getElementById('btn-open-share').addEventListener('click', () => {
    audio.playTap();
    document.getElementById('modal-share').classList.remove('hidden');
  });

  // Close Share Modal
  document.getElementById('btn-close-share').addEventListener('click', () => {
    audio.playTap();
    document.getElementById('modal-share').classList.add('hidden');
  });

  // Close modals on background click
  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });

  // Ledger Filter Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      audio.playTap();
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.ledgerType = btn.getAttribute('data-type');
      fetchLedger(true);
    });
  });

  // Load More Transactions
  document.getElementById('btn-load-more').addEventListener('click', () => {
    audio.playTap();
    fetchLedger(false);
  });
}

// =========================================================
// 7. Initialization
// =========================================================
async function init() {
  setupEventHandlers();
  await fetchConfig();
  await handleOAuthCallback();
  ensureAuthToken();
  await fetchAccount();
  await fetchLedger(true);
}

window.addEventListener('DOMContentLoaded', init);
