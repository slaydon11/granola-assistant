/**
 * User auth store — DynamoDB-backed with AES-256-GCM encryption.
 *
 * DynamoDB key scheme:
 *   PK: USER#<phone>  SK: GRANOLA_TOKENS   — encrypted OAuth tokens
 *   PK: USER#<phone>  SK: PROFILE          — chatId, timestamps
 *   PK: USER#<phone>  SK: JUST_ONBOARDED   — one-shot flag (10min TTL)
 *   PK: USER#<phone>  SK: PENDING_AUTH     — PKCE verifier during OAuth (10min TTL)
 *
 * Falls back to in-memory store if DynamoDB is unavailable (local dev).
 */
import { getItem, putItem, deleteItem } from '../db/dynamodb.js';
import { encrypt, decrypt } from './encryption.js';

/**
 * Normalize handles used as DynamoDB PK suffixes so Linq `from` formats match OAuth-stored keys.
 * Non-phone ids (e.g. web-ui) are returned trimmed unchanged.
 */
export function canonicalUserId(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (!/\d/.test(t)) return t;
  if (t.startsWith('+')) {
    const rest = t.slice(1).replace(/\D/g, '');
    return rest ? `+${rest}` : t;
  }
  const digits = t.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return t;
}

/** PK suffixes to read (canonical first, then legacy raw). */
function storageKeysForRead(raw: string): string[] {
  const trimmed = raw.trim();
  const canon = canonicalUserId(raw);
  const keys = [canon];
  if (trimmed && trimmed !== canon) keys.push(trimmed);
  return [...new Set(keys)];
}

function storageKeyWrite(raw: string): string {
  return canonicalUserId(raw);
}

function mergeProfiles(a: UserProfile | null, b: UserProfile | null): UserProfile | null {
  if (!a) return b;
  if (!b) return a;
  return {
    phoneNumber: storageKeyWrite(a.phoneNumber || b.phoneNumber),
    chatId: a.chatId || b.chatId,
    createdAt: Math.min(a.createdAt, b.createdAt),
    lastActive: Math.max(a.lastActive, b.lastActive),
  };
}

// ── Types ────────────────────────────────────────────────────────────

export interface GranolaTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface UserProfile {
  phoneNumber: string;
  chatId?: string;
  createdAt: number;
  lastActive: number;
}

export interface PendingAuth {
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  chatId?: string;
}

// ── In-memory fallback (for local dev without DynamoDB) ──────────────

const memStore = new Map<string, { tokens?: GranolaTokens; profile?: UserProfile; pending?: PendingAuth }>();
let useDynamo = true;

async function tryDynamo<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!useDynamo) return fallback;
  try {
    return await fn();
  } catch (error: unknown) {
    const code = (error as { name?: string }).name;
    if (code === 'ResourceNotFoundException' || code === 'UnrecognizedClientException') {
      console.warn('[auth-store] DynamoDB unavailable — using in-memory store (dev mode)');
      useDynamo = false;
    } else {
      console.error('[auth-store] DynamoDB error:', error);
    }
    return fallback;
  }
}

// ── User Profile ─────────────────────────────────────────────────────

async function fetchProfileDynamo(pkSuffix: string): Promise<UserProfile | null> {
  const item = await getItem<UserProfile & { PK: string; SK: string }>(
    `USER#${pkSuffix}`, 'PROFILE',
  );
  return item ? { phoneNumber: item.phoneNumber, chatId: item.chatId, createdAt: item.createdAt, lastActive: item.lastActive } : null;
}

export async function getUserProfile(phone: string): Promise<UserProfile | null> {
  const keys = storageKeysForRead(phone);
  return tryDynamo(async () => {
    let merged: UserProfile | null = null;
    for (const k of keys) {
      merged = mergeProfiles(merged, await fetchProfileDynamo(k));
    }
    return merged;
  }, (() => {
    let merged: UserProfile | null = null;
    for (const k of keys) {
      merged = mergeProfiles(merged, memStore.get(k)?.profile || null);
    }
    return merged;
  })());
}

export async function setUserProfile(phone: string, profile: Partial<UserProfile>): Promise<void> {
  const key = storageKeyWrite(phone);
  const now = Date.now();
  const existing = await getUserProfile(phone);

  const full: UserProfile = {
    phoneNumber: key,
    chatId: profile.chatId || existing?.chatId,
    createdAt: existing?.createdAt || now,
    lastActive: now,
  };

  await tryDynamo(async () => {
    await putItem(`USER#${key}`, 'PROFILE', full as unknown as Record<string, unknown>);
  }, undefined);

  // In-memory fallback
  const mem = memStore.get(key) || {};
  mem.profile = full;
  memStore.set(key, mem);
}

// ── Granola OAuth Tokens (encrypted at rest) ─────────────────────────

async function fetchTokensDynamo(pkSuffix: string): Promise<GranolaTokens | null> {
  const item = await getItem<{ encrypted: string }>(
    `USER#${pkSuffix}`, 'GRANOLA_TOKENS',
  );
  if (!item?.encrypted) return null;
  return decrypt(item.encrypted) as GranolaTokens;
}

export async function getGranolaTokens(phone: string): Promise<GranolaTokens | null> {
  const keys = storageKeysForRead(phone);
  return tryDynamo(async () => {
    for (const k of keys) {
      const t = await fetchTokensDynamo(k);
      if (t?.accessToken) return t;
    }
    return null;
  }, (() => {
    for (const k of keys) {
      const t = memStore.get(k)?.tokens;
      if (t?.accessToken) return t;
    }
    return null;
  })());
}

export async function setGranolaTokens(phone: string, tokens: GranolaTokens): Promise<void> {
  const key = storageKeyWrite(phone);
  const encrypted = encrypt(tokens);

  await tryDynamo(async () => {
    await putItem(`USER#${key}`, 'GRANOLA_TOKENS', { encrypted });
  }, undefined);

  // In-memory fallback
  const mem = memStore.get(key) || {};
  mem.tokens = tokens;
  memStore.set(key, mem);

  console.log(`[auth-store] Tokens saved for ${key} (encrypted)`);
}

export async function clearGranolaTokens(phone: string): Promise<void> {
  const keys = storageKeysForRead(phone);
  await tryDynamo(async () => {
    for (const k of keys) {
      await deleteItem(`USER#${k}`, 'GRANOLA_TOKENS');
    }
  }, undefined);

  for (const k of keys) {
    const mem = memStore.get(k);
    if (mem) mem.tokens = undefined;
  }

  console.log(`[auth-store] Tokens cleared for ${keys.join(', ')}`);
}

// ── Auth State Check ─────────────────────────────────────────────────

export async function isUserAuthed(phone: string): Promise<boolean> {
  const tokens = await getGranolaTokens(phone);
  return !!tokens?.accessToken;
}

// ── Pending Auth (PKCE verifier, stored during OAuth flow) ───────────

export async function setPendingAuth(phone: string, pending: PendingAuth): Promise<void> {
  const key = storageKeyWrite(phone);
  await tryDynamo(async () => {
    await putItem(`USER#${key}`, 'PENDING_AUTH', pending as unknown as Record<string, unknown>, 600); // 10min TTL
  }, undefined);

  const mem = memStore.get(key) || {};
  mem.pending = pending;
  memStore.set(key, mem);
}

export async function getPendingAuth(phone: string): Promise<PendingAuth | null> {
  const keys = storageKeysForRead(phone);
  return tryDynamo(async () => {
    for (const k of keys) {
      const item = await getItem<PendingAuth & { PK: string; SK: string }>(
        `USER#${k}`, 'PENDING_AUTH',
      );
      if (item?.codeVerifier) {
        return { codeVerifier: item.codeVerifier, clientId: item.clientId, clientSecret: item.clientSecret, chatId: item.chatId };
      }
    }
    return null;
  }, (() => {
    for (const k of keys) {
      const p = memStore.get(k)?.pending;
      if (p?.codeVerifier) return p;
    }
    return null;
  })());
}

export async function clearPendingAuth(phone: string): Promise<void> {
  const keys = storageKeysForRead(phone);
  await tryDynamo(async () => {
    for (const k of keys) {
      await deleteItem(`USER#${k}`, 'PENDING_AUTH');
    }
  }, undefined);

  for (const k of keys) {
    const mem = memStore.get(k);
    if (mem) mem.pending = undefined;
  }
}

// ── Just Onboarded (one-shot flag) ───────────────────────────────────

export async function setJustOnboarded(phone: string): Promise<void> {
  const key = storageKeyWrite(phone);
  await tryDynamo(async () => {
    await putItem(`USER#${key}`, 'JUST_ONBOARDED', { onboarded: true }, 600); // 10min TTL
  }, undefined);
}

export async function consumeJustOnboarded(phone: string): Promise<boolean> {
  const keys = storageKeysForRead(phone);
  return tryDynamo(async () => {
    for (const k of keys) {
      const item = await getItem<{ onboarded: boolean }>(`USER#${k}`, 'JUST_ONBOARDED');
      if (item?.onboarded) {
        await deleteItem(`USER#${k}`, 'JUST_ONBOARDED');
        return true;
      }
    }
    return false;
  }, false);
}
