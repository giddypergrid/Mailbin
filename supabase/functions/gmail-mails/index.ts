import { handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { verifyJwt } from '../_shared/auth.ts';
import { logWeird, log } from '../_shared/logger.ts';
import { processAttachments } from '../_shared/attachment-processor.ts';
import { classifyWithGemini } from '../_shared/gemini.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

type GmailConnection = {
  id: string;
  email: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
};

type GmailListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
};

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { size?: number; attachmentId?: string };
  parts?: GmailPart[];
};

type GmailMessageResponse = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: GmailPart[];
    mimeType?: string;
    filename?: string;
    body?: { size?: number; attachmentId?: string };
  };
};

const getHeader = (message: GmailMessageResponse, name: string) => {
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
};

const collectAttachments = (parts: GmailPart[] | undefined): Array<{ filename: string; mimeType: string; sizeBytes: number; attachmentId?: string }> => {
  if (!parts) return [];

  const results: Array<{ filename: string; mimeType: string; sizeBytes: number; attachmentId?: string }> = [];

  for (const part of parts) {
    if (part.filename) {
      results.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId,
      });
    }

    if (part.parts) {
      results.push(...collectAttachments(part.parts));
    }
  }

  return results;
};

const formatDate = (value: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

const fetchUserConnection = async (supabaseUrl: string, serviceRoleKey: string, userId: string) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/gmail_connections?select=id,email,access_token,refresh_token,expires_at&user_id=eq.${userId}&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error('gmail_connection_lookup_failed');
  }

  const rows = await response.json() as GmailConnection[];

  return rows[0] ?? null;
};

const refreshAccessToken = async (connection: GmailConnection, supabaseUrl: string, serviceRoleKey: string) => {
  if (!connection.refresh_token) {
    throw new Error('gmail_refresh_token_missing');
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token,
    }),
  });
  const tokenJson = await tokenResponse.json() as GoogleTokenResponse;

  if (!tokenResponse.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error ?? 'gmail_token_refresh_failed');
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
    : null;

  const updateResponse = await fetch(`${supabaseUrl}/rest/v1/gmail_connections?id=eq.${connection.id}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      access_token: tokenJson.access_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!updateResponse.ok) {
    throw new Error('gmail_token_update_failed');
  }

  return tokenJson.access_token;
};

const getValidAccessToken = async (connection: GmailConnection, supabaseUrl: string, serviceRoleKey: string) => {
  if (!connection.expires_at) {
    return connection.access_token;
  }

  const expiresAt = new Date(connection.expires_at).getTime();
  const expiresSoon = expiresAt - Date.now() < 60_000;

  if (!expiresSoon) {
    return connection.access_token;
  }

  return refreshAccessToken(connection, supabaseUrl, serviceRoleKey);
};

const fetchGmailMessages = async (accessToken: string, limit: number, maxAttachmentKb: number, pageToken?: string) => {
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('maxResults', String(limit));
  listUrl.searchParams.set('q', 'in:inbox is:unread');
  if (pageToken) listUrl.searchParams.set('pageToken', pageToken);

  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listJson = await listResponse.json() as GmailListResponse;

  if (!listResponse.ok) {
    throw new Error('gmail_message_list_failed');
  }

  const messageIds = listJson.messages ?? [];
  const results: Array<{
    id: string; bin: string; from: string; subject: string; summary: string;
    aiSummary?: string;
    aiTheme?: string;
    aiFromWho?: string;
    receivedAt: string; gmailUrl: string; source: string;
    attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number; category: string }>;
    attachmentTotalKb?: number;
    attachmentWithinLimit?: boolean;
    skippedAttachments?: number;
    hasLargeAttachments?: boolean;
  }> = [];
  let rateLimited = false;

  for (let i = 0; i < messageIds.length; i += 3) {
    const batch = messageIds.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(async (item) => {
      const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}`);
      messageUrl.searchParams.set('format', 'full');

      const messageResponse = await fetch(messageUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const message = await messageResponse.json() as GmailMessageResponse;

      if (!messageResponse.ok) {
        logWeird('GMAIL-MAILS', 'Failed to read individual message', {
          messageId: item.id,
          status: messageResponse.status,
        });
        if (messageResponse.status === 429) {
          rateLimited = true;
        }
        return null;
      }

      const subject = getHeader(message, 'Subject') || '(No subject)';
      const dateHeader = getHeader(message, 'Date');
      const receivedAt = message.internalDate ? formatDate(message.internalDate) : formatDate(dateHeader);

      const rawAttachments = collectAttachments(message.payload?.parts);

      const attachmentResult = rawAttachments.length > 0
        ? processAttachments(rawAttachments, maxAttachmentKb)
        : null;

      return {
        id: `gmail-${message.id}`,
        bin: 'emergency',
        from: getHeader(message, 'From') || 'Unknown sender',
        subject,
        summary: message.snippet || subject,
        receivedAt,
        gmailUrl: `https://mail.google.com/mail/u/0/#inbox/${message.threadId}`,
        source: 'gmail',
        attachments: attachmentResult
          ? attachmentResult.processed.map((att) => ({
              filename: att.filename,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              category: att.category,
            }))
          : undefined,
        attachmentTotalKb: attachmentResult?.totalKb,
        attachmentWithinLimit: attachmentResult?.withinLimit,
        skippedAttachments: attachmentResult?.skippedAttachments.length,
        hasLargeAttachments: attachmentResult ? !attachmentResult.withinLimit : false,
      };
    }));

    for (const mail of batchResults) {
      if (mail) results.push(mail);
    }

    if (i + 3 < messageIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  return { messages: results, nextPageToken: listJson.nextPageToken, rateLimited };
};

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  try {
    const requestUrl = new URL(req.url);
    const requestedLimit = Number(requestUrl.searchParams.get('limit') ?? '10');
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 10, 1), 100);
    const pageToken = requestUrl.searchParams.get('pageToken') ?? undefined;
    const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
    const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
    const userId = await verifyJwt(req);

    if (!userId) {
      return jsonResponse({ messages: [], status: 'not_connected', diagnostics: { reason: 'no_jwt' } });
    }

    const connection = await fetchUserConnection(supabaseUrl, serviceRoleKey, userId);

    if (!connection) {
      return jsonResponse({ messages: [], status: 'not_connected', diagnostics: { reason: 'no_gmail_connection' } });
    }

    let maxAttachmentKb = 100;
    let systemInstruction = '';
    let sendAttachmentsToAi = false;

    try {
      const coreMemoryResponse = await fetch(
        `${supabaseUrl}/rest/v1/core_memory?user_id=eq.${userId}&limit=1`,
        { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
      );

      if (coreMemoryResponse.ok) {
        const coreMemoryRows = await coreMemoryResponse.json() as Array<{
          memory_text: string;
          attachment_max_size_kb: number;
          send_attachments_to_ai: boolean;
        }>;
        const row = coreMemoryRows[0];
        if (row) {
          maxAttachmentKb = row.attachment_max_size_kb ?? 100;
          systemInstruction = row.memory_text ?? '';
          sendAttachmentsToAi = row.send_attachments_to_ai ?? false;
        }
      }
    } catch {
      // defaults already set above
    }

    const accessToken = await getValidAccessToken(connection, supabaseUrl, serviceRoleKey);
    const { messages, nextPageToken, rateLimited } = await fetchGmailMessages(accessToken, limit, maxAttachmentKb, pageToken);

    let classificationResult: Record<string, { bin: string; summary: string; theme: string; fromWho: string }> = {};

    if (Deno.env.get('GEMINI_API_KEY') && messages.length > 0 && !pageToken && systemInstruction) {
      log('GMAIL-MAILS', 'Calling Gemini for classification', {
        emailCount: messages.length,
        systemInstructionLength: systemInstruction.length,
        sampleId: messages[0]?.id,
      });

      const emailInputs = messages.map((m) => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        snippet: m.summary,
      }));

      const geminiResult = await classifyWithGemini(systemInstruction, emailInputs);
      classificationResult = Object.fromEntries(
        Object.entries(geminiResult).map(([id, data]) => [id, {
          bin: data.bin,
          summary: data.summary,
          theme: data.theme,
          fromWho: data.fromWho,
        }]),
      );

      log('GMAIL-MAILS', 'Gemini classification returned', {
        classifiedCount: Object.keys(classificationResult).length,
      });

      for (const message of messages) {
        const rawId = message.id.replace(/^gmail-/, '');
        const match = classificationResult[message.id] ?? classificationResult[rawId];
        if (match) {
          message.bin = match.bin;
          if (match.summary) message.aiSummary = match.summary;
          if (match.theme) message.aiTheme = match.theme;
          if (match.fromWho) message.aiFromWho = match.fromWho;
        }
      }
    } else {
      log('GMAIL-MAILS', 'Skipping Gemini classification', {
        hasApiKey: !!Deno.env.get('GEMINI_API_KEY'),
        messageCount: messages.length,
        isFirstPage: !pageToken,
        hasSystemInstruction: !!systemInstruction,
        systemInstructionLength: systemInstruction.length,
      });
    }

    log('GMAIL-MAILS', 'Fetch complete', {
      count: messages.length,
      hasMorePage: !!nextPageToken,
      rateLimited,
    });

    return jsonResponse({
      messages,
      status: 'ready',
      nextPageToken: nextPageToken ?? null,
      rateLimited,
      diagnostics: {
        hasGeminiKey: !!Deno.env.get('GEMINI_API_KEY'),
        isFirstPage: !pageToken,
        hasSystemInstruction: !!systemInstruction,
        systemInstructionPreview: systemInstruction ? systemInstruction.slice(0, 80) : null,
        classificationAttempted: !!Deno.env.get('GEMINI_API_KEY') && messages.length > 0 && !pageToken && !!systemInstruction,
        classifiedCount: Object.keys(classificationResult).length,
        sampleResult: classificationResult,
      },
    });
  } catch (error) {
    logWeird('GMAIL-MAILS', 'Fetch failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({
      messages: [],
      status: 'error',
      reason: error instanceof Error ? error.message : 'gmail_fetch_failed',
    }, 500);
  }
});
