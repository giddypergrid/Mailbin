import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/http.ts';
import { log } from '../_shared/logger.ts';

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const gmailScopes = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.get('Cookie') ?? '';
  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
  const cookie = cookies.find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

Deno.serve((req: Request) => {
  const corsResponse = handleCors(req);

  if (corsResponse) {
    return corsResponse;
  }

  try {
    const clientId = requireEnv('GOOGLE_CLIENT_ID');
    const redirectUri = requireEnv('GOOGLE_REDIRECT_URI');
    const existingState = readCookie(req, 'OauthState');
    const OauthState = existingState ?? crypto.randomUUID();
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');

    log('OAUTH-START', 'Redirecting to Google consent', { OauthState, redirectUri, reusedExistingState: !!existingState });

    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', gmailScopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', OauthState);

    const secureCookie = new URL(req.url).protocol === 'https:' ? '; Secure' : '';

    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        Location: authUrl.toString(),
        'Set-Cookie': `OauthState=${OauthState}; HttpOnly${secureCookie}; SameSite=Lax; Path=/; Max-Age=600`,
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'OAuth start failed', {
      status: 500,
      headers: corsHeaders,
    });
  }
});
