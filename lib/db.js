/* =========================================================
   ONE BANK (원뱅크) — Database Module (Neon Postgres)
   - ns_players (통합 자금 잔고) & ns_ledger (실시간 원장)
   - bank_accounts (고유 가상 계좌번호 777-01-XXXXXX & 일일 파킹이자)
   ========================================================= */
import pg from 'pg';

pg.types.setTypeParser(20, v => Number(v)); // BIGINT -> number
pg.types.setTypeParser(1700, v => parseFloat(v)); // NUMERIC -> number

let pool = null;
let dbAvailable = false;

if (process.env.DATABASE_URL) {
  try {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', e => console.error('[DB] Postgres Pool Error:', e.message));
  } catch (err) {
    console.warn('[DB] Failed to init pool:', err.message);
  }
}

// 오프라인/게스트 인메모리 폴백 저장소
const mem = {
  players: new Map(),
  accounts: new Map(),
  ledger: []
};

export async function q(text, params = []) {
  if (!pool) throw new Error('Database pool not initialized');
  return pool.query(text, params);
}

export async function initSchema() {
  if (!pool) {
    console.log('[DB] DATABASE_URL 없음. 인메모리 모드로 동작합니다.');
    return;
  }

  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
    console.log('[DB] Neon Postgres 연결 성공. ONE BANK 중앙 뱅킹 시스템 가동!');

    // 1. ns_players
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ns_players (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        balance          BIGINT NOT NULL DEFAULT 1000000 CHECK (balance >= 0),
        credit           INTEGER NOT NULL DEFAULT 500,
        spins            INTEGER NOT NULL DEFAULT 0,
        bankruptcies     INTEGER NOT NULL DEFAULT 0,
        last_bankrupt_at TIMESTAMPTZ,
        npc_blacklist    TEXT[] NOT NULL DEFAULT '{}',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen        TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ns_ledger (
        id            BIGSERIAL PRIMARY KEY,
        player_id     TEXT NOT NULL,
        delta         BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        reason        TEXT NOT NULL,
        ref           TEXT,
        at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ns_ledger_player_idx ON ns_ledger (player_id, at DESC);

      CREATE TABLE IF NOT EXISTS bank_accounts (
        player_id              TEXT PRIMARY KEY,
        account_no             TEXT UNIQUE NOT NULL,
        account_name           TEXT NOT NULL DEFAULT 'ONE 주거래 자유입출금통장',
        interest_last_claimed  TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS bank_accounts_accno_idx ON bank_accounts (account_no);
    `);
  } catch (err) {
    console.warn('[DB] DB 초기화 실패, 인메모리 모드로 전환:', err.message);
    dbAvailable = false;
  }
}

export function isDbAvailable() {
  return dbAvailable;
}

// 777-01-XXXXXX 형식 고유 계좌번호 생성기
function generateAccountNo(playerId) {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  const part1 = '777';
  const part2 = '01';
  const num = (hash % 900000 + 100000).toString();
  return `${part1}-${part2}-${num}`;
}

// 계좌 정보 조회 또는 신규 개설
export async function getOrCreateAccount(playerId, nickname = '고객') {
  if (!dbAvailable || !pool) {
    if (!mem.players.has(playerId)) {
      mem.players.set(playerId, { id: playerId, name: nickname, balance: 1000000, credit: 500 });
      mem.accounts.set(playerId, {
        player_id: playerId,
        account_no: generateAccountNo(playerId),
        account_name: 'ONE 주거래 자유입출금통장',
        interest_last_claimed: null,
        created_at: new Date()
      });
    }
    const p = mem.players.get(playerId);
    const a = mem.accounts.get(playerId);
    return formatAccountInfo(p, a);
  }

  try {
    // 1. 유저 조회
    let pRes = await pool.query('SELECT * FROM ns_players WHERE id = $1', [playerId]);
    if (!pRes.rows.length) {
      pRes = await pool.query(
        `INSERT INTO ns_players (id, name, balance) VALUES ($1, $2, 1000000)
         ON CONFLICT (id) DO UPDATE SET last_seen = now(), name = EXCLUDED.name
         RETURNING *`,
        [playerId, nickname]
      );
    }
    const player = pRes.rows[0];

    // 2. 뱅크 계좌 조회
    let aRes = await pool.query('SELECT * FROM bank_accounts WHERE player_id = $1', [playerId]);
    if (!aRes.rows.length) {
      const defaultAccNo = generateAccountNo(playerId);
      aRes = await pool.query(
        `INSERT INTO bank_accounts (player_id, account_no)
         VALUES ($1, $2)
         ON CONFLICT (player_id) DO UPDATE SET account_name = EXCLUDED.account_name
         RETURNING *`,
        [playerId, defaultAccNo]
      );
    }
    const account = aRes.rows[0];

    return formatAccountInfo(player, account);
  } catch (err) {
    console.error('[DB] getOrCreateAccount Error:', err.message);
    throw err;
  }
}

// 파킹통장 일일 이자 계산 (연 3.5% 일할 계산)
function calculateParkingInterest(balance, lastClaimed) {
  const now = new Date();
  if (lastClaimed) {
    const lastDate = new Date(lastClaimed);
    const isSameDay =
      now.getFullYear() === lastDate.getFullYear() &&
      now.getMonth() === lastDate.getMonth() &&
      now.getDate() === lastDate.getDate();
    if (isSameDay) {
      return { canClaim: false, amount: 0, reason: '오늘 이미 이자를 수령하셨습니다.' };
    }
  }

  // 연 3.5% 일할 계산: balance * 0.035 / 365
  const interest = Math.max(1, Math.floor((balance * 0.035) / 365));
  return { canClaim: true, amount: interest, reason: '지금 바로 받기 가능!' };
}

function formatAccountInfo(player, account) {
  const interestInfo = calculateParkingInterest(player.balance, account.interest_last_claimed);
  return {
    playerId: player.id,
    name: player.name,
    accountNo: account.account_no,
    accountName: account.account_name,
    balance: Number(player.balance),
    credit: player.credit,
    created_at: account.created_at,
    interest_last_claimed: account.interest_last_claimed,
    dailyInterest: interestInfo
  };
}

// 송금 대상자 검색 (계좌번호 또는 닉네임)
export async function searchRecipient(query) {
  query = String(query).trim();
  if (!query) return null;

  if (!dbAvailable || !pool) {
    for (const [pId, a] of mem.accounts.entries()) {
      const p = mem.players.get(pId);
      if (a.account_no === query || p.name.toLowerCase() === query.toLowerCase()) {
        return {
          playerId: p.id,
          name: p.name,
          accountNo: a.account_no,
          accountName: a.account_name
        };
      }
    }
    return null;
  }

  try {
    // 1. 계좌번호로 조회
    let res = await pool.query(
      `SELECT p.id, p.name, b.account_no, b.account_name
       FROM bank_accounts b
       JOIN ns_players p ON b.player_id = p.id
       WHERE b.account_no = $1
       LIMIT 1`,
      [query]
    );

    if (res.rows.length) {
      const r = res.rows[0];
      return { playerId: r.id, name: r.name, accountNo: r.account_no, accountName: r.account_name };
    }

    // 2. 닉네임으로 조회
    res = await pool.query(
      `SELECT p.id, p.name, b.account_no, b.account_name
       FROM ns_players p
       LEFT JOIN bank_accounts b ON p.id = b.player_id
       WHERE LOWER(p.name) = LOWER($1)
       LIMIT 1`,
      [query]
    );

    if (res.rows.length) {
      const r = res.rows[0];
      let accNo = r.account_no;
      if (!accNo) {
        accNo = generateAccountNo(r.id);
        await pool.query(
          `INSERT INTO bank_accounts (player_id, account_no) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [r.id, accNo]
        );
      }
      return { playerId: r.id, name: r.name, accountNo: accNo, accountName: r.account_name || 'ONE 주거래 자유입출금통장' };
    }

    return null;
  } catch (err) {
    console.error('[DB] searchRecipient Error:', err.message);
    return null;
  }
}

// 실시간 계좌 송금 (Transfer) — PostgreSQL 원자적 트랜잭션
export async function transferFunds({ fromPlayerId, toIdentifier, amount, senderMemo = '', recipientMemo = '' }) {
  amount = Math.floor(Number(amount));
  if (isNaN(amount) || amount <= 0) {
    throw new Error('송금 금액은 1원 이상이어야 합니다.');
  }

  // 1. 받는 사람 조회
  const recipient = await searchRecipient(toIdentifier);
  if (!recipient) {
    throw new Error('존재하지 않는 계좌번호 또는 닉네임입니다.');
  }

  if (recipient.playerId === fromPlayerId) {
    throw new Error('본인 계좌로는 송금할 수 없습니다.');
  }

  // 인메모리 폴백 처리
  if (!dbAvailable || !pool) {
    const sender = mem.players.get(fromPlayerId);
    const recPlayer = mem.players.get(recipient.playerId);
    if (!sender || sender.balance < amount) {
      throw new Error('계좌 잔액이 부족합니다.');
    }

    sender.balance -= amount;
    recPlayer.balance += amount;

    const txId = 'TX' + Date.now();
    mem.ledger.unshift({
      id: Date.now(),
      player_id: fromPlayerId,
      delta: -amount,
      balance_after: sender.balance,
      reason: 'transfer_out',
      ref: `[송금] 받는분: ${recipient.name} (${recipient.accountNo}) | ${senderMemo || '송금'}`,
      at: new Date()
    });

    mem.ledger.unshift({
      id: Date.now() + 1,
      player_id: recipient.playerId,
      delta: amount,
      balance_after: recPlayer.balance,
      reason: 'transfer_in',
      ref: `[입금] 보낸분: ${sender.name} | ${recipientMemo || '입금'}`,
      at: new Date()
    });

    return {
      txId,
      fromName: sender.name,
      toName: recipient.name,
      toAccountNo: recipient.accountNo,
      amount,
      balanceAfter: sender.balance,
      senderMemo,
      timestamp: new Date()
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 보내는 사람 잔고 락
    const sRes = await client.query(
      'SELECT id, name, balance FROM ns_players WHERE id = $1 FOR UPDATE',
      [fromPlayerId]
    );
    if (!sRes.rows.length) throw new Error('보내는 분 계좌 정보를 찾을 수 없습니다.');
    const sender = sRes.rows[0];

    if (Number(sender.balance) < amount) {
      throw new Error(`잔액이 부족합니다. (현재 잔고: ₩${Number(sender.balance).toLocaleString()})`);
    }

    // 받는 사람 락
    const rRes = await client.query(
      'SELECT id, name, balance FROM ns_players WHERE id = $1 FOR UPDATE',
      [recipient.playerId]
    );
    if (!rRes.rows.length) throw new Error('받는 분 계좌 정보를 찾을 수 없습니다.');
    const recPlayer = rRes.rows[0];

    // 차감 & 입금
    const newSenderBal = Number(sender.balance) - amount;
    const newRecBal = Number(recPlayer.balance) + amount;

    await client.query('UPDATE ns_players SET balance = $1 WHERE id = $2', [newSenderBal, fromPlayerId]);
    await client.query('UPDATE ns_players SET balance = $1 WHERE id = $2', [newRecBal, recipient.playerId]);

    // 원장 기록 (보내는 분)
    const sendRef = `받는분: ${recipient.name} (${recipient.accountNo})` + (senderMemo ? ` | ${senderMemo}` : '');
    const l1 = await client.query(
      `INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref)
       VALUES ($1, $2, $3, 'transfer_out', $4) RETURNING id`,
      [fromPlayerId, -amount, newSenderBal, sendRef]
    );

    // 원장 기록 (받는 분)
    const recRef = `보낸분: ${sender.name}` + (recipientMemo ? ` | ${recipientMemo}` : '');
    await client.query(
      `INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref)
       VALUES ($1, $2, $3, 'transfer_in', $4)`,
      [recipient.playerId, amount, newRecBal, recRef]
    );

    await client.query('COMMIT');

    return {
      txId: `TX${l1.rows[0].id}`,
      fromName: sender.name,
      toName: recipient.name,
      toAccountNo: recipient.accountNo,
      amount,
      balanceAfter: newSenderBal,
      senderMemo,
      timestamp: new Date()
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 파킹통장 일일 이자 수령
export async function claimParkingInterest(playerId) {
  const account = await getOrCreateAccount(playerId);
  if (!account.dailyInterest.canClaim || account.dailyInterest.amount <= 0) {
    throw new Error(account.dailyInterest.reason);
  }

  const interestAmount = account.dailyInterest.amount;

  if (!dbAvailable || !pool) {
    const p = mem.players.get(playerId);
    p.balance += interestAmount;
    mem.accounts.get(playerId).interest_last_claimed = new Date();
    mem.ledger.unshift({
      id: Date.now(),
      player_id: playerId,
      delta: interestAmount,
      balance_after: p.balance,
      reason: 'parking_interest',
      ref: '파킹통장 연 3.5% 일일 이자 입금',
      at: new Date()
    });
    return { amount: interestAmount, newBalance: p.balance };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pRes = await client.query(
      'SELECT balance FROM ns_players WHERE id = $1 FOR UPDATE',
      [playerId]
    );
    const newBal = Number(pRes.rows[0].balance) + interestAmount;

    await client.query('UPDATE ns_players SET balance = $1 WHERE id = $2', [newBal, playerId]);
    await client.query(
      'UPDATE bank_accounts SET interest_last_claimed = now() WHERE player_id = $1',
      [playerId]
    );

    await client.query(
      `INSERT INTO ns_ledger (player_id, delta, balance_after, reason, ref)
       VALUES ($1, $2, $3, 'parking_interest', 'ONE 파킹통장 연 3.5% 일일 이자 입금')`,
      [playerId, interestAmount, newBal]
    );

    await client.query('COMMIT');
    return { amount: interestAmount, newBalance: newBal };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// 전체 거래 내역 조회 (페이징 & 라벨 포맷)
export async function getTransactions(playerId, { limit = 40, offset = 0, type = 'all' }) {
  if (!dbAvailable || !pool) {
    let items = mem.ledger.filter(l => l.player_id === playerId);
    if (type === 'deposit') items = items.filter(l => l.delta > 0);
    if (type === 'withdraw') items = items.filter(l => l.delta < 0);
    return items.slice(offset, offset + limit).map(formatLedgerRow);
  }

  try {
    let query = `SELECT * FROM ns_ledger WHERE player_id = $1`;
    const params = [playerId];

    if (type === 'deposit') {
      query += ` AND delta > 0`;
    } else if (type === 'withdraw') {
      query += ` AND delta < 0`;
    }

    query += ` ORDER BY at DESC LIMIT $2 OFFSET $3`;
    params.push(limit, offset);

    const { rows } = await pool.query(query, params);
    return rows.map(formatLedgerRow);
  } catch (err) {
    console.error('[DB] getTransactions Error:', err.message);
    return [];
  }
}

// 거래 내역 카테고리 태깅 및 한국어 라벨링
function formatLedgerRow(r) {
  let category = '기타';
  let icon = '💳';
  let title = r.reason;

  switch (r.reason) {
    case 'transfer_out':
      category = '송금';
      icon = '💸';
      title = r.ref || '타 계좌 이체';
      break;
    case 'transfer_in':
      category = '입금';
      icon = '📥';
      title = r.ref || '계좌 입금';
      break;
    case 'parking_interest':
      category = '이자';
      icon = '💰';
      title = 'ONE 파킹통장 일일 이자';
      break;
    case 'gtb_fence_sell':
      category = '엄복동';
      icon = '🚲';
      title = `[엄복동 찹샵] ${r.ref || '자전거 장물 매각'}`;
      break;
    case 'survival_reward':
      category = '엄복동';
      icon = '🔥';
      title = `[5분 사수 챌린지] 성공 포상금`;
      break;
    case 'gtb_bail':
      category = '벌금';
      icon = '🚨';
      title = `[경찰청 보석금] 체포 석방금`;
      break;
    case 'slots_win':
      category = '카지노';
      icon = '🎰';
      title = `[네온스트립 슬롯] 잭팟 당첨금`;
      break;
    case 'slots_spin':
      category = '카지노';
      icon = '🎰';
      title = `[네온스트립 슬롯] 슬롯 베팅`;
      break;
    case 'jarket_sell':
      category = '마켓';
      icon = '🛒';
      title = `[자켓 마켓] 판매 대금 입금`;
      break;
    case 'jarket_buy':
      category = '마켓';
      icon = '🛒';
      title = `[자켓 마켓] 상품 결제`;
      break;
    case 'nexus_stock_sell':
      category = '증권';
      icon = '📈';
      title = `[넥서스 증권] 주식 매도 대금`;
      break;
    case 'nexus_stock_buy':
      category = '증권';
      icon = '📈';
      title = `[넥서스 증권] 주식 매수 체결`;
      break;
    default:
      if (r.delta > 0) {
        icon = '📥';
        title = r.ref || r.reason;
      } else {
        icon = '📤';
        title = r.ref || r.reason;
      }
  }

  return {
    id: r.id,
    category,
    icon,
    title,
    delta: Number(r.delta),
    balanceAfter: Number(r.balance_after),
    at: r.at
  };
}
