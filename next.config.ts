import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  // Packaged Electron loads the static export through file://, so production
  // asset URLs must be relative. Leaving assetPrefix as './' in `next dev`
  // breaks App Router hydration inside Electron.
  output: 'export',
  ...(isProd ? { assetPrefix: './' } : {}),
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
