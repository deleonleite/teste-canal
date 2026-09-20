import { ReceiptView } from '@/components/receipt-view';

export default async function Confirmed({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ protocol?: string }> }) {
  const [{ tenant }, { protocol }] = await Promise.all([params, searchParams]);
  return <ReceiptView tenant={tenant} protocolParam={protocol ?? null} />;
}
