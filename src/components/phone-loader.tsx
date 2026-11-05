'use client';
import dynamic from 'next/dynamic';
const Phone = dynamic(() => import('./phone-app'), {
  ssr: false,
  loading: () => <div className="phone-loading">Opening your account…</div>,
});
export function PhoneLoader() {
  return <Phone />;
}
