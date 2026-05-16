import { type GmailListResponse, type GmailMessageResponse, type GmailConnection } from './types.ts';
import { requireEnv } from './http.ts';
import { logWeird } from './logger.ts';
import { saveAccessToken } from './db.ts';
import { CONFIG } from './config.ts';

export async function fetchMessageList(accessToken: string, limit: number, pageToken?: string, query?: string): Promise<GmailListResponse> {
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('maxResults', String(limit));
  listUrl.searchParams.set('q', query ?? 'in:inbox is:unread');
  if (pageToken) listUrl.searchParams.set('pageToken', pageToken);

  const response = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await response.json() as GmailListResponse;

  if (!response.ok) {
    throw new Error('gmail_message_list_failed');
  }

  return json;
}

export async function fetchMessageDetail(accessToken: string, messageId: string): Promise<{ ok: boolean; status: number; data: GmailMessageResponse }> {
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
