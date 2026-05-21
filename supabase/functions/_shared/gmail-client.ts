import { type GmailListResponse, type GmailMessageResponse, type GmailConnection } from './types.ts';
import { requireEnv } from './http.ts';
import { saveAccessToken } from './db.ts';
import { CONFIG } from './config.ts';

export type ListResult = { ok: boolean; status: number; data: GmailListResponse };
export type DetailResult = { ok: boolean; status: number; data: GmailMessageResponse };

// Single-attempt fetch. Caller surfaces failure to frontend via errorStage;
// frontend handles wait + retry. No internal retry loop — diagnose-fast wins
// over silent re-tries that block the response for many seconds.
export async function fetchMessageList(
  accessToken: string,
  limit: number,
  pageToken?: string,
  query?: string,
): Promise<ListResult> {
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('maxResults', String(limit));
  listUrl.searchParams.set('q', query ?? 'in:inbox is:unread category:primary');
  if (pageToken) listUrl.searchParams.set('pageToken', pageToken);

  const response = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json() as GmailListResponse;
  return { ok: response.ok, status: response.status, data };
}

export async function fetchMessageDetail(
  accessToken: string,
  messageId: string,
): Promise<DetailResult> {
  const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
  messageUrl.searchParams.set('format', 'full');

  const response = await fetch(messageUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json() as GmailMessageResponse;
  return { ok: response.ok, status: response.status, data };
}

export async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<{ accessToken: string; expiresAt: string | null } | { error: string }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const json = await response.json() as { access_token?: string; expires_in?: number; error?: string };

  if (!response.ok || !json.access_token) {
    return { error: json.error ?? 'gmail_token_refresh_failed' };
  }

  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null,
  };
}

export async function markMessageRead(accessToken: string, messageId: string): Promise<boolean> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    },
  );
  return response.ok;
}

export async function getValidAccessToken(connection: GmailConnection, supabaseUrl: string, serviceRoleKey: string): Promise<string> {
  if (!connection.expires_at) {
    return connection.access_token;
  }

  const expiresSoon = new Date(connection.expires_at).getTime() - Date.now() < CONFIG.fetch.tokenRefreshWindowMs;
  if (!expiresSoon) {
    return connection.access_token;
  }

  if (!connection.refresh_token) {
    throw new Error('gmail_refresh_token_missing');
  }

  const clientId = requireEnv('GOOGLE_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');
  const result = await refreshAccessToken(clientId, clientSecret, connection.refresh_token);

  if ('error' in result) {
    throw new Error(result.error);
  }

  const saved = await saveAccessToken(supabaseUrl, serviceRoleKey, connection.id, result.accessToken, result.expiresAt);
  if (!saved) {
    throw new Error('gmail_token_update_failed');
  }

  return result.accessToken;
}
