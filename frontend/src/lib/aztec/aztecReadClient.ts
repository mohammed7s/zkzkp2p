/**
 * Direct Aztec node client for reading public contract state
 * No Azguard needed - queries the node directly via RPC
 */

import { AZTEC_NODE_URL, AZTEC_TRAIN_ADDRESS } from '../train/contracts';

// Simple RPC call to Aztec node
async function rpcCall(method: string, params: any[] = []): Promise<any> {
  const response = await fetch(AZTEC_NODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || 'RPC error');
  }
  return data.result;
}

/**
 * Get current Aztec block number
 */
export async function getAztecBlockNumber(): Promise<number> {
  const tips = await rpcCall('node_getL2Tips');
  if (!tips?.latest?.number) {
    throw new Error('Failed to get Aztec block number');
  }
  return tips.latest.number;
}

/**
 * Get current Aztec L2 tips (latest, proven, finalized blocks)
 */
export async function getAztecL2Tips(): Promise<{ latest: number; proven: number; finalized: number }> {
  const tips = await rpcCall('node_getL2Tips');
  if (!tips?.latest?.number) {
    throw new Error('Failed to get Aztec L2 tips');
  }
  return {
    latest: tips.latest.number,
    proven: tips.proven?.number ?? tips.latest.number,
    finalized: tips.finalized?.number ?? tips.latest.number,
  };
}

/**
 * Check node health
 */
export async function isAztecNodeHealthy(): Promise<boolean> {
  try {
    const nodeInfo = await rpcCall('node_getNodeInfo');
    return !!nodeInfo?.nodeVersion;
  } catch {
    return false;
  }
}

/**
 * Get public logs from Aztec node
 * Use this to watch for DstLocked events (solver locked on Aztec)
 */
export async function getPublicLogs(fromBlock: number, toBlock: number): Promise<any[]> {
  try {
    const result = await rpcCall('node_getPublicLogs', [{ fromBlock, toBlock }]);
    return result?.logs || [];
  } catch (error) {
    console.error('[AztecRead] Failed to get public logs:', error);
    return [];
  }
}

/**
 * Check if there's a DstLocked log for a specific swapId
 * This detects when solver has locked on Aztec without needing Azguard
 */
export async function checkForSolverLock(swapId: string, fromBlock: number): Promise<boolean> {
  if (!AZTEC_TRAIN_ADDRESS) {
    console.warn('[AztecRead] Train address not configured');
    return false;
  }

  try {
    const tips = await getAztecL2Tips();
    const toBlock = tips.latest;

    if (fromBlock >= toBlock) {
      return false;
    }

    // Convert swapId to hex format for matching (logs use hex)
    const swapIdHex = '0x' + BigInt(swapId).toString(16).padStart(64, '0');
    console.log('[AztecRead] Checking blocks', fromBlock, '-', toBlock, 'for swapId:', swapIdHex.slice(0, 20) + '...');

    // Query recent logs
    const logs = await getPublicLogs(fromBlock, toBlock);

    // Look for logs from Train contract containing our swapId
    for (const log of logs) {
      const contractAddr = log?.log?.contractAddress?.toLowerCase();
      const fields = log?.log?.fields || [];

      // Check if log is from Train contract
      if (contractAddr !== AZTEC_TRAIN_ADDRESS.toLowerCase()) {
        continue;
      }

      // Check if any field matches our swapId (field[1] is typically swapId in DstLocked)
      for (const field of fields) {
        if (field?.toLowerCase() === swapIdHex.toLowerCase()) {
          console.log('[AztecRead] Found solver lock for swapId!');
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.error('[AztecRead] Error checking for solver lock:', error);
    return false;
  }
}
