import { NextRequest, NextResponse } from 'next/server';

const CANONICAL_HOST = 'voiddex-alpha.vercel.app';
const RELAY_ONLY_PATHS = new Set(['/relay', '/health', '/state']);

function relayCors(request: NextRequest) {
  const origin = request.headers.get('origin');
  const configured = (process.env.RELAY_ALLOWED_ORIGINS ?? 'https://voiddex-alpha.vercel.app,http://localhost:3000')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (origin && !configured.includes(origin)) return null;
  const headers = new Headers({
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
  });
  if (origin) headers.set('access-control-allow-origin', origin);
  return headers;
}

/** Keep previews from becoming alternate transaction-signing surfaces. */
export function proxy(request: NextRequest) {
  if (process.env.RELAY_ONLY === '1') {
    if (!RELAY_ONLY_PATHS.has(request.nextUrl.pathname)) {
      return NextResponse.json({ error: 'This host only serves the independent relay.' }, { status: 404 });
    }
    const headers = relayCors(request);
    if (!headers) return NextResponse.json({ error: 'Origin is not allowed.' }, { status: 403 });
    if (request.method === 'OPTIONS') return new NextResponse(null, { status: 204, headers });
    const response = NextResponse.next();
    headers.forEach((value, key) => response.headers.set(key, value));
    return response;
  }
  if (process.env.VERCEL && request.nextUrl.hostname !== CANONICAL_HOST) {
    const canonical = request.nextUrl.clone();
    canonical.protocol = 'https:';
    canonical.host = CANONICAL_HOST;
    canonical.port = '';
    return NextResponse.redirect(canonical, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
