import { NextRequest, NextResponse } from 'next/server';

const CANONICAL_HOST = 'voiddex-alpha.vercel.app';

/** Keep previews from becoming alternate transaction-signing surfaces. */
export function proxy(request: NextRequest) {
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
