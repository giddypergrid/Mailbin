import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { jsonResponse, requireEnv } from '../_shared/http.ts';
import { log, logWeird } from '../_shared/logger.ts';
import { ensureCoreMemory } from '../_shared/db.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleUserInfoResponse = {
  email?: string;
};
async function ensureSupabaseUser(
  email: string
): Promise<{ id: string; accessToken: string; refreshToken: string }> {
  const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
  const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
  const tempPassword = crypto.randomUUID();

  const adminHeaders = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };

  const listResponse = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    { headers: adminHeaders }
  );
  const list = await listResponse.json() as { users: Array<{ id: string }> };
  const existing = list.users?.[0];

  let userId: string;

  if (existing) {
    userId = existing.id;
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: tempPassword }),
    });
  } else {
    const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: tempPassword, email_confirm: true }),
    });
    if (!createResponse.ok) {
      const createErrorBody = await createResponse.text();
      logWeird('OAUTH-CALLBACK', 'Supabase user create failed', {
        status: createResponse.status,
        body: createErrorBody,
      });
      throw new Error('supabase_user_create_failed');
    }
    const createdUser = await createResponse.json() as { id: string };
    userId = createdUser.id;
  }

  // Sign in to get session tokens
  const tokenResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: tempPassword }),
  });
  const tokenJson = await tokenResponse.json() as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  };

  if (!tokenResponse.ok || !tokenJson.access_token) {
    logWeird('OAUTH-CALLBACK', 'Supabase token exchange failed', {
      status: tokenResponse.status,
      error: tokenJson.error,
      email,
    });
    throw new Error(tokenJson.error ?? 'supabase_token_exchange_failed');
  }

  return {
    id: userId,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token!,
  };
}
const readCookie = (req: Request, name: string) => {
  const cookieHeader = req.headers.get('Cookie') ?? '';
  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
  const cookie = cookies.find((item) => item.startsWith(`${name}=`));

  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
};

const redirect = (frontendUrl: string, params: Record<string, string>) => {
  const url = new URL(frontendUrl);

  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders,
      Location: url.toString(),
      'Set-Cookie': 'OauthState=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
};

const saveConnection = async (
  tokenJson: GoogleTokenResponse,
  email: string,
  userId: string
) => {
  if (!tokenJson.access_token) {
    throw new Error('missing_access_token');
  }

  const supabaseUrl = requireEnv('MAILBIN_SUPABASE_URL');
  const serviceRoleKey = requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY');
  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000).toISOString()
    : null;

  const saveResponse = await fetch(`${supabaseUrl}/rest/v1/gmail_connections?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      email,
      user_id: userId,
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      token_type: tokenJson.token_type,
      scope: tokenJson.scope,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!saveResponse.ok) {
    throw new Error('gmail_connection_save_failed');
  }
};

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  const frontendUrl = requireEnv('FRONTEND_URL');

  try {
    const requestUrl = new URL(req.url);
    //Google returns the code and state as query parameters to the redirect URI
    const code = requestUrl.searchParams.get('code');
    const OauthState = requestUrl.searchParams.get('state');
    const expectedState = readCookie(req, 'OauthState');
    const error = requestUrl.searchParams.get('error');

    if (error) {
      log('OAUTH-CALLBACK', 'Google returned error', { error });
      return redirect(frontendUrl, { gmail: 'error', reason: error });
    }
    //Need to check if coockie state matches Oauth returned state.
    if (!code || !OauthState || !expectedState || OauthState !== expectedState) {
      logWeird('OAUTH-CALLBACK', 'State mismatch', {
        hasCode: !!code,
        hasOauthState: !!OauthState,
        hasExpectedState: !!expectedState,
        OauthState,
        expectedState,
        allCookies: req.headers.get('Cookie'),
      });
      return redirect(frontendUrl, { gmail: 'error', reason: 'invalid_state' });
    }

    const clientId = requireEnv('GOOGLE_CLIENT_ID');
    const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET');
    const redirectUri = requireEnv('GOOGLE_REDIRECT_URI');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    const tokenJson = await tokenResponse.json() as GoogleTokenResponse;

    if (!tokenResponse.ok || tokenJson.error) {
      logWeird('OAUTH-CALLBACK', 'Token exchange failed', {
        status: tokenResponse.status,
        error: tokenJson.error,
        error_description: tokenJson.error_description,
      });
      return redirect(frontendUrl, {
        gmail: 'error',
        reason: tokenJson.error ?? 'token_exchange_failed',
      });
    }

    const email = tokenJson.id_token
      ? JSON.parse(atob(tokenJson.id_token.split('.')[1])).email as string
      : null;

    if (!email) {
      logWeird('OAUTH-CALLBACK', 'Email not found in id_token', { hasIdToken: !!tokenJson.id_token });
      return redirect(frontendUrl, { gmail: 'error', reason: 'email_not_found' });
    }

    log('OAUTH-CALLBACK', 'Token exchange succeeded', { email });
    const supabaseUser = await ensureSupabaseUser(email);
    await saveConnection(tokenJson, email, supabaseUser.id);
    await ensureCoreMemory(
      requireEnv('MAILBIN_SUPABASE_URL'),
      requireEnv('MAILBIN_SUPABASE_SERVICE_ROLE_KEY'),
      supabaseUser.id,
    );

    return redirect(frontendUrl, {
      gmail: 'connected',
      accessToken: supabaseUser.accessToken,
      refreshToken: supabaseUser.refreshToken,
    });
  } catch (error) {
    return redirect(frontendUrl, {
      gmail: 'error',
      reason: error instanceof Error ? error.message : 'oauth_callback_failed',
    });
  }
});
