import { useState, useEffect } from 'react';
import { useWalletClient } from 'wagmi';
import { getZkp2pAccountDeposits, formatUSDC } from '@/lib/zkp2p/client';
import { BASE_EXPLORER_URL } from '@/config';

export function MyDeposits({ ownerAddress }: { ownerAddress: string }) {
  const { data: walletClient } = useWalletClient();
  const [deposits, setDeposits] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!walletClient || !ownerAddress) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await getZkp2pAccountDeposits(walletClient, ownerAddress as `0x${string}`);
        if (!cancelled) {
          setDeposits(Array.isArray(result) ? result : []);
        }
      } catch (e: any) {
        if (!cancelled) {
          console.warn('[MyDeposits] Failed to fetch:', e.message);
          setError(e.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletClient, ownerAddress]);

  if (loading) {
    return <div className="text-xs text-gray-600 animate-pulse">loading deposits...</div>;
  }

  if (deposits.length === 0) return null;

  return (
    <div className="border border-gray-800 p-4 space-y-3">
      <div className="text-xs text-gray-500 uppercase tracking-wide">your deposits on peer.xyz</div>

      {deposits.map((d, i) => {
        const amount = BigInt(d.amount?.toString() || '0');
        const remaining = BigInt(d.remainingDeposits?.toString() || '0');
        const id = BigInt(d.depositId?.toString() || '0');

        return (
          <div key={i} className="border border-gray-800 p-3 space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-sm text-white">#{id.toString()}</span>
              <span className="text-sm text-white">{formatUSDC(amount)} USDC</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-500">remaining</span>
              <span className="text-gray-400">{formatUSDC(remaining)} USDC</span>
            </div>
            <div className="flex gap-2 pt-1">
              <a
                href={`https://peer.xyz`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gray-600 hover:text-gray-400 underline"
              >view on peer.xyz</a>
            </div>
          </div>
        );
      })}

      {error && (
        <div className="text-xs text-red-600">{error}</div>
      )}
    </div>
  );
}
