// Vercel Edge Middleware — THE security boundary for Ambition CBT 2.0.
// Verifies the HMAC session cookie using Web Crypto (Edge has no node:crypto).
// Token format must stay byte-identical to lib/session.js.

export const config = { matcher: ['/:path*'] };

const COOKIE_NAME = 'ambition_beta_session';
const VERSION = 'v1';

const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session',
  '/offline.html',
  '/manifest.json',
  '/service-worker.js',
  '/favicon.ico'
];
const PUBLIC_PREFIXES = ['/assets/', '/icons/'];

function isPublic(pathname) {
  if (PUBLIC_PATHS.indexOf(pathname) !== -1) return true;
  for (let i = 0; i < PUBLIC_PREFIXES.length; i++) {
    if (pathname.startsWith(PUBLIC_PREFIXES[i])) return true;
  }
  return false;
}

function b64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const base64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifySession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;

  const signingInput = VERSION + '.' + parts[1];
  const enc = new TextEncoder();

  let key;
  try {
    key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['verify']
    );
  } catch (e) { return null; }

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      'HMAC', key, b64urlToBytes(parts[2]), enc.encode(signingInput)
    );
  } catch (e) { return null; }
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch (e) { return null; }

  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function readCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i].indexOf('=');
    if (idx < 0) continue;
    if (parts[i].slice(0, idx).trim() === name) {
      try { return decodeURIComponent(parts[i].slice(idx + 1).trim()); }
      catch (e) { return null; }
    }
  }
  return null;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const isApi = pathname.startsWith('/api/');

  // Emergency bypass — set BETA_GATE_ENABLED=false in Vercel to restore open access.
  if (process.env.BETA_GATE_ENABLED === 'false') {
    return isApi ? undefined : Response.next();
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    return new Response('Server misconfigured: SESSION_SECRET missing.', { status: 500 });
  }

  const token = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  const payload = await verifySession(token, secret);

  if (payload) {
    // Already signed in → bounce away from /login.
    if (pathname === '/login') {
      return Response.redirect(new URL('/', url).toString(), 302);
    }
    return Response.next();
  }

  if (isPublic(pathname)) {
    return Response.next();
  }

  if (isApi) {
    return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const loginUrl = new URL('/login', url);
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname);
  return Response.redirect(loginUrl.toString(), 302);
}
