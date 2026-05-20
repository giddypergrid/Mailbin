import { type GmailConnection, type CoreMemoryRow, type GmailEmailRow } from './types.ts';
import { logWeird } from './logger.ts';
import { CONFIG } from './config.ts';

export const supabaseHeaders = (serviceRoleKey: string) => ({
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  'Content-Type': 'application/json',
});

export async function fetchUserConnection(supabaseUrl: string, serviceRoleKey: string, userId: string): Promise<GmailConnection | null> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gmail_connections?select=id,email,access_token,refresh_token,expires_at,last_synced_at&user_id=eq.${userId}&limit=1`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );

  if (!response.ok) {
    throw new Error('gmail_connection_lookup_failed');
  }

  const rows = await response.json() as GmailConnection[];
  return rows[0] ?? null;
}

export async function fetchCoreMemory(supabaseUrl: string, serviceRoleKey: string, userId: string): Promise<CoreMemoryRow | null> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/core_memory?user_id=eq.${userId}&limit=1`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );

  if (!response.ok) return null;

  const rows = await response.json() as CoreMemoryRow[];
  return rows[0] ?? null;
}

export async function ensureCoreMemory(supabaseUrl: string, serviceRoleKey: string, userId: string): Promise<void> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/core_memory`,
    {
      method: 'POST',
      headers: { ...supabaseHeaders(serviceRoleKey), Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({
        user_id: userId,
        custom_rules: CONFIG.coreMemory.defaultRules,
        mark_emails_as_read: true,
      }),
    },
  );
  if (!response.ok) {
    logWeird('DB', 'ensureCoreMemory insert failed', { status: response.status });
  }
}

export async function saveAccessToken(supabaseUrl: string, serviceRoleKey: string, connectionId: string, accessToken: string, expiresAt: string | null): Promise<boolean> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gmail_connections?id=eq.${connectionId}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(serviceRoleKey),
      body: JSON.stringify({
        access_token: accessToken,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  return response.ok;
}

export async function fetchExistingMessageIds(supabaseUrl: string, serviceRoleKey: string, userId: string, gmailIds: string[]): Promise<string[]> {
  if (gmailIds.length === 0) return [];

  const idsParam = gmailIds.map(id => `"${id}"`).join(',');
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gmail_emails?select=gmail_message_id&user_id=eq.${userId}&gmail_message_id=in.(${idsParam})`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );

  if (!response.ok) {
    logWeird('DB', 'fetchExistingMessageIds failed', { status: response.status });
    return [];
  }

  const rows = await response.json() as Array<{ gmail_message_id: string }>;
  return rows.map(r => r.gmail_message_id);
}

export async function upsertEmail(supabaseUrl: string, serviceRoleKey: string, email: Record<string, unknown>): Promise<boolean> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gmail_emails?on_conflict=gmail_message_id,user_id`,
    {
      method: 'POST',
      headers: { ...supabaseHeaders(serviceRoleKey), Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(email),
    },
  );

  if (!response.ok) {
    logWeird('DB', 'upsertEmail failed', { status: response.status });
    return false;
  }
  return true;
}

export async function updateLastSyncedAt(supabaseUrl: string, serviceRoleKey: string, connectionId: string, timestamp?: string): Promise<boolean> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gmail_connections?id=eq.${connectionId}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(serviceRoleKey),
      body: JSON.stringify({ last_synced_at: timestamp ?? new Date().toISOString(), updated_at: new Date().toISOString() }),
    },
  );

  return response.ok;
}

export async function markEmailRead(supabaseUrl: string, serviceRoleKey: string, userId: string, gmailMessageId: string): Promise<boolean> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/gmail_emails?user_id=eq.${userId}&gmail_message_id=eq.${gmailMessageId}`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(serviceRoleKey),
      body: JSON.stringify({ is_read: true }),
    },
  );
  return response.ok;
}

export async function saveFeedback(supabaseUrl: string, serviceRoleKey: string, userId: string, gmailMessageId: string, feedbackText: string): Promise<boolean> {
  const wordCount = feedbackText.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 30) return false;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_feedback`,
    {
      method: 'POST',
      headers: supabaseHeaders(serviceRoleKey),
      body: JSON.stringify({
        user_id: userId,
        gmail_message_id: gmailMessageId,
        feedback_text: feedbackText,
      }),
    },
  );
  return response.ok;
}

export async function fetchUnprocessedFeedback(supabaseUrl: string, serviceRoleKey: string, userId: string): Promise<Array<{ id: string; gmail_message_id: string; feedback_text: string; created_at: string }>> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_feedback?select=id,gmail_message_id,feedback_text,created_at&user_id=eq.${userId}&processed=eq.false&order=created_at.asc`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  if (!response.ok) return [];
  return await response.json() as Array<{ id: string; gmail_message_id: string; feedback_text: string; created_at: string }>;
}

export async function markFeedbackProcessed(supabaseUrl: string, serviceRoleKey: string, userId: string, feedbackIds: string[]): Promise<boolean> {
  const idsParam = feedbackIds.map(id => `"${id}"`).join(',');
  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_feedback?user_id=eq.${userId}&id=in.(${idsParam})`,
    {
      method: 'PATCH',
      headers: supabaseHeaders(serviceRoleKey),
      body: JSON.stringify({ processed: true }),
    },
  );
  return response.ok;
}

export async function fetchEmails(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  bin?: string,
  before?: string,
  limit: number = 20,
): Promise<{ rows: GmailEmailRow[]; nextCursor: string | null }> {
  let url = `${supabaseUrl}/rest/v1/gmail_emails?select=*&user_id=eq.${userId}&is_read=eq.false&order=received_at.desc.nullslast&limit=${limit}`;
  if (bin) url += `&bin=eq.${bin}`;
  if (before) url += `&received_at=lt.${before}`;

  const response = await fetch(url, { headers: supabaseHeaders(serviceRoleKey) });

  if (!response.ok) {
    logWeird('DB', 'fetchEmails failed', { status: response.status });
    return { rows: [], nextCursor: null };
  }

  const rows = await response.json() as GmailEmailRow[];
  const nextCursor = rows.length === limit ? rows[rows.length - 1].received_at ?? null : null;
  return { rows, nextCursor };
}
