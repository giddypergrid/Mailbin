import { requireEnv } from './http.ts';
import { logWeird } from './logger.ts';

type JwtPublicKey = { kty: string; crv: string; x: string; y: string };

function base64UrlDecode(str: string): ArrayBuffer {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

async function verifyJwtSignature(token: string, publicKey: JwtPublicKey): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signingInput);
}

export async function verifyJwt(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const publicKeyJson = requireEnv('MAILBIN_JWT_PUBLIC_KEY');
  let publicKey: JwtPublicKey;
  try {
    publicKey = JSON.parse(publicKeyJson);
  } catch {
    logWeird('AUTH', 'Failed to parse JWT public key');
    return null;
  }

  const parts = token.split('.');
  let payload: { sub?: string; exp?: number } | null = null;
  try {
    payload = JSON.parse(atob(parts[1]));
  } catch {
    logWeird('AUTH', 'JWT payload parse failed');
    return null;
  }

  const isValid = await verifyJwtSignature(token, publicKey);
  if (!isValid) {
    logWeird('AUTH', 'JWT signature verification failed', { sub: payload?.sub });
    return null;
  }

  return payload.sub ?? null;
}
