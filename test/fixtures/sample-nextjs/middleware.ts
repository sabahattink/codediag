export { default } from "next-auth/middleware";

// Only the dashboard is protected; API routes must check the session themselves.
export const config = { matcher: ["/dashboard/:path*"] };
