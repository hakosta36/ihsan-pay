import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Ihsan · Payments Lab',
  description:
    'A working Solana devnet payment prototype. Independent portfolio project; not the official Ihsan application.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
