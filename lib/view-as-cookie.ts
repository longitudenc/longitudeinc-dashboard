// lib/view-as-cookie.ts
//
// Just the cookie name, in its own module so middleware.ts can import it
// WITHOUT dragging in lib/view-as.ts.
//
// middleware runs on the EDGE runtime. lib/view-as.ts imports lib/session.ts,
// which imports node:crypto — unavailable on Edge. That combination can build
// cleanly and then fail on every request, which is the worst way to find out.
// One shared constant beats either a duplicated string literal (drift) or a
// runtime mismatch.

export const VIEW_AS_COOKIE = 'longitude_view_as'
