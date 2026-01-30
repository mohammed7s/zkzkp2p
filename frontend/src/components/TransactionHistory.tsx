'use client';

import { useState } from 'react';
import { useFlowStore } from '@/stores/flowStore';
import { formatTokenAmount } from '@/lib/bridge';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TransactionHistory() {
  const { completedFlows } = useFlowStore();
  const [expanded, setExpanded] = useState(false);

  const flows = [...completedFlows].reverse();

  return (
    <div className="mt-8 border border-gray-900 bg-gray-950/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex justify-between items-center p-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span className="uppercase">transaction history ({flows.length})</span>
        <span>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-900">
          {flows.length === 0 ? (
            <div className="p-4 text-xs text-gray-700 text-center">no transactions yet</div>
          ) : (
            <div className="divide-y divide-gray-900">
              {flows.map((flow, i) => {
                const isShield = flow.direction === 'base_to_aztec';
                const amount = formatTokenAmount(BigInt(flow.amount));
                return (
                  <div key={`${flow.orderId || i}-${flow.createdAt}`} className="p-3 space-y-1">
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-2">
                        <span className={isShield ? 'text-purple-400' : 'text-blue-400'}>
                          {isShield ? 'Base → Aztec' : 'Aztec → Base'}
                        </span>
                        <span className="text-gray-400">{amount} USDC</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={flow.status === 'completed' ? 'text-green-600' : 'text-red-600'}>
                          {flow.status}
                        </span>
                        <span className="text-gray-700">{timeAgo(flow.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="text-xs text-gray-700 space-y-0.5">
                      {flow.txHashes.open && (
                        <div>
                          {isShield ? 'base' : 'aztec'} tx:{' '}
                          <a
                            href={isShield
                              ? `https://sepolia.basescan.org/tx/${flow.txHashes.open}`
                              : `https://devnet.aztecscan.xyz/tx-effects/${flow.txHashes.open}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`${isShield ? 'text-blue-600 hover:text-blue-400' : 'text-green-600 hover:text-green-400'} underline`}
                          >
                            {flow.txHashes.open.slice(0, 10)}...{flow.txHashes.open.slice(-6)}
                          </a>
                        </div>
                      )}
                      {flow.txHashes.claim && (
                        <div>
                          {isShield ? 'aztec' : 'base'} tx:{' '}
                          <a
                            href={isShield
                              ? `https://devnet.aztecscan.xyz/tx-effects/${flow.txHashes.claim}`
                              : `https://sepolia.basescan.org/tx/${flow.txHashes.claim}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`${isShield ? 'text-green-600 hover:text-green-400' : 'text-blue-600 hover:text-blue-400'} underline`}
                          >
                            {flow.txHashes.claim.slice(0, 10)}...{flow.txHashes.claim.slice(-6)}
                          </a>
                        </div>
                      )}
                      {flow.error && <div className="text-red-700">{flow.error}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
