import { Lab } from '@/components/lab';
export default function Page() {
  return (
    <Lab
      configured={Boolean(
        process.env.NEXT_PUBLIC_PRIVY_APP_ID &&
        process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      )}
      leftOrigin={process.env.NEXT_PUBLIC_LEFT_PHONE_ORIGIN || ''}
    />
  );
}
