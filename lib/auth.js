/* =========================================================
   ONE BANK (원뱅크) — Auth Module (ONEID SSO & Guest)
   ========================================================= */
import { getOrCreateAccount } from './db.js';

export const ONEID_URL = (process.env.ONEID_URL || 'https://oneid-icvq.onrender.com').replace(/\/$/, '');
export const CLIENT_ID = process.env.ONEID_CLIENT_ID || 'onebank';

const CACHE_MS = 60_000;
const cache = new Map();

export class AuthError extends Error {
  constructor(msg, status = 401) { super(msg); this.status = status; }
}

function decodePayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

export async function verifyToken(token) {
  if (!token) throw new AuthError('로그인이 필요합니다.');

  // 1. 게스트 모드 토큰 지원
  if (token.startsWith('guest_')) {
    const parts = token.split('_');
    const guestId = parts.slice(0, 2).join('_');
    const guestName = decodeURIComponent(parts[2] || '익명의고객');
    const acc = await getOrCreateAccount(guestId, guestName);
    return { id: acc.playerId, name: acc.name, isGuest: true };
  }

  // 2. 캐시 확인
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;

  // 3. ONEID 검증
  let res;
  try {
    res = await fetch(`${ONEID_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    const p = decodePayload(token);
    if (p && p.sub) {
      const uid = String(p.sub);
      const name = String(p.nickname || p.username || 'ONEID고객').slice(0, 24);
      const acc = await getOrCreateAccount(uid, name);
      return { id: acc.playerId, name: acc.name, isOffline: true };
    }
    throw new AuthError('ONEID 인증 서버에 연결할 수 없습니다.', 503);
  }

  if (!res.ok) {
    cache.delete(token);
    const body = await res.json().catch(() => ({}));
    throw new AuthError(body.detail || '로그인이 만료되었습니다.', res.status === 403 ? 403 : 401);
  }

  const u = await res.json();
  const uid = String(u.id || u.sub);
  const name = String(u.nickname || u.username || '고객').slice(0, 24);
  const acc = await getOrCreateAccount(uid, name);

  const user = { id: acc.playerId, name: acc.name, role: u.role, isGuest: false };
  cache.set(token, { user, until: Date.now() + CACHE_MS });
  return user;
}

export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies?.oneid_token || req.query.token);
    req.user = await verifyToken(token);
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}
