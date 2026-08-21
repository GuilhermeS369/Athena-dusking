import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  // A autenticação é validada nas páginas e rotas server-side. Manter o
  // middleware sem imports server-only evita que o bundle Edge tente resolver
  // `__dirname` e derrube toda a aplicação na Vercel.
  return NextResponse.next({ request });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
