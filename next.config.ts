import type { NextConfig } from 'next';
const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((x) => new URL(x.trim()).origin)
  .join(' ');
const config: NextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors 'self' ${origins}; object-src 'none'; base-uri 'self'`,
          },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
