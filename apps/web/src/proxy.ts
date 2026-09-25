import { NextResponse } from "next/server";

import { strictTransportSecurityForOrigin } from "./security/transport";

export function proxy(): NextResponse {
  const response = NextResponse.next();
  const hsts = strictTransportSecurityForOrigin(process.env.PUBLIC_ORIGIN);
  if (hsts !== undefined) response.headers.set("strict-transport-security", hsts);
  return response;
}

export const config = {
  matcher: "/:path*",
};
