#!/usr/bin/env tsx
/**
 * E2E Deposit Flow Test Script
 *
 * Tests the full deposit flow: Aztec → Base → zkp2p deposit
 *
 * Stages:
 *   1. Derive burner wallet (from a test EVM private key)
 *   2. Bridge Aztec → Base via Substance SDK (requires Azguard + solver)
 *   3. Create gasless zkp2p deposit via Coinbase Paymaster
 *
 * Usage:
 *   # Full flow (needs Azguard browser context for stage 2 - skip it here)
 *   EVM_PRIVATE_KEY=0x... tsx scripts/test-deposit-e2e.ts
 *
 *   # Skip bridge, just test burner + zkp2p deposit (assumes funds already on burner)
 *   EVM_PRIVATE_KEY=0x... SKIP_BRIDGE=1 tsx scripts/test-deposit-e2e.ts
 *
 *   # Just test burner derivation
 *   EVM_PRIVATE_KEY=0x... STAGE=burner tsx scripts/test-deposit-e2e.ts
 *
 *   # Just test zkp2p deposit (provide burner key directly)
 *   BURNER_PRIVATE_KEY=0x... STAGE=zkp2p tsx scripts/test-deposit-e2e.ts
 *
 * Environment:
 *   EVM_PRIVATE_KEY          - Main EVM wallet private key (for burner derivation)
 *   BURNER_PRIVATE_KEY       - (Optional) Skip derivation, use this burner key directly
 *   DEPOSIT_AMOUNT           - USDC amount to deposit (default: "1.00")
 *   PAYMENT_METHOD           - revolut | wise | venmo (default: "revolut")
 *   PAYMENT_TAG              - Payment identifier, e.g. @revtag (default: "@testuser")
 *   CURRENCY                 - USD | EUR | GBP (default: "USD")
 *   STAGE                    - Run only a specific stage: burner | bridge | zkp2p | all (default: "all")
 *   SKIP_BRIDGE              - Set to "1" to skip bridge stage (assumes funds on burner)
 *   DRY_RUN                  - Set to "1" to simulate without sending transactions
 *
 *   # From .env.local (or set directly):
 *   NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS
 *   NEXT_PUBLIC_BASE_TOKEN_ADDRESS
 *   NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL
 *   NEXT_PUBLIC_BASE_RPC_URL
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseUnits,
  type Hex,
  type PublicClient,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, encodePacked } from 'viem'

// ---------------------------------------------------------------------------
// Load .env.local if present
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const envPath = resolve(__dirname, '../frontend/.env.local')
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY as Hex | undefined
const BURNER_PRIVATE_KEY = process.env.BURNER_PRIVATE_KEY as Hex | undefined
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || '1.00'
const PAYMENT_METHOD = (process.env.PAYMENT_METHOD || 'revolut') as 'revolut' | 'wise' | 'venmo'
const PAYMENT_TAG = process.env.PAYMENT_TAG || '@testuser'
const CURRENCY = (process.env.CURRENCY || 'USD') as 'USD' | 'EUR' | 'GBP'
const STAGE = process.env.STAGE || 'all'
const SKIP_BRIDGE = process.env.SKIP_BRIDGE === '1'
const DRY_RUN = process.env.DRY_RUN === '1'

const BASE_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_BASE_TOKEN_ADDRESS as Hex
const AZTEC_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS as Hex
const PAYMASTER_RPC_URL = process.env.NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL
const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'

// USDC has 6 decimals
const USDC_DECIMALS = 6

// ERC20 ABI subset
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function log(stage: string, msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23)
  const prefix = `[${ts}] [${stage}]`
  if (data !== undefined) {
    console.log(prefix, msg, typeof data === 'bigint' ? data.toString() : data)
  } else {
    console.log(prefix, msg)
  }
}

function logSuccess(stage: string, msg: string) {
  console.log(`\n  ✓ [${stage}] ${msg}\n`)
}

function logError(stage: string, msg: string, err?: any) {
  console.error(`\n  ✗ [${stage}] ${msg}`)
  if (err) console.error('   ', err?.message || err)
  console.error()
}

// ---------------------------------------------------------------------------
// Stage 1: Burner Derivation
// ---------------------------------------------------------------------------
// Mirrors frontend/src/lib/burner/index.ts but without MetaMask (uses raw private key)

const DOMAIN = 'zkzkp2p'
const DERIVATION_VERSION = 'v2'

function getMasterKeyMessage(address: Hex): string {
  return [
    `${DOMAIN} master key ${DERIVATION_VERSION}`,
    `Address: ${address}`,
    '',
    'Sign this message to derive your zkzkp2p master key.',
    'This allows recovery of burner wallets if needed.',
  ].join('\n')
}

function deriveMasterKey(signature: Hex): Hex {
  return keccak256(encodePacked(['string', 'bytes'], [DOMAIN + '-master', signature]))
}

function deriveBurnerKeyFromMaster(masterKey: Hex, nonce: number): Hex {
  return keccak256(encodePacked(['bytes32', 'uint64'], [masterKey, BigInt(nonce)]))
}

function generateNonce(): number {
  return Math.floor(Date.now() / 60000)
}

async function deriveBurner(evmPrivateKey: Hex): Promise<{
  privateKey: Hex
  eoaAddress: Hex
  smartAccountAddress: Hex
  nonce: number
}> {
  const account = privateKeyToAccount(evmPrivateKey)
  const mainAddress = account.address

  log('BURNER', `Main address: ${mainAddress}`)

  // Sign the master key message (same as MetaMask would)
  const message = getMasterKeyMessage(mainAddress)
  const signature = await account.signMessage({ message }) as Hex

  log('BURNER', 'Master key message signed')

  const masterKey = deriveMasterKey(signature)
  const nonce = generateNonce()
  const burnerKey = deriveBurnerKeyFromMaster(masterKey, nonce)
  const burnerAccount = privateKeyToAccount(burnerKey)

  log('BURNER', `Nonce: ${nonce}`)
  log('BURNER', `Burner EOA: ${burnerAccount.address}`)

  // Get smart account address (deterministic from burner key)
  const smartAccountAddress = await getSmartAccountAddress(burnerKey)
  log('BURNER', `Smart account: ${smartAccountAddress}`)

  return {
    privateKey: burnerKey,
    eoaAddress: burnerAccount.address,
    smartAccountAddress,
    nonce,
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Bridge (Aztec → Base)
// ---------------------------------------------------------------------------
// NOTE: The Substance Bridge SDK requires an AzguardClient (browser extension).
// This stage cannot be fully automated from CLI.
// When running from CLI, either:
//   - Skip with SKIP_BRIDGE=1 (assumes funds already on the burner smart account)
//   - Or manually fund the burner smart account address with USDC on Base

async function checkBridgePrereqs() {
  if (!AZTEC_TOKEN_ADDRESS) {
    throw new Error('NEXT_PUBLIC_AZTEC_TOKEN_ADDRESS not set')
  }
  if (!BASE_TOKEN_ADDRESS) {
    throw new Error('NEXT_PUBLIC_BASE_TOKEN_ADDRESS not set')
  }
  log('BRIDGE', `Aztec token: ${AZTEC_TOKEN_ADDRESS}`)
  log('BRIDGE', `Base token:  ${BASE_TOKEN_ADDRESS}`)
  log('BRIDGE', 'Bridge requires Azguard (browser extension) + running solver')
  log('BRIDGE', 'Skipping bridge stage for CLI — fund the burner smart account manually')
  log('BRIDGE', 'Or set SKIP_BRIDGE=1 if already funded')
}

// ---------------------------------------------------------------------------
// Stage 3: Paymaster + zkp2p Deposit
// ---------------------------------------------------------------------------

async function getSmartAccountAddress(privateKey: Hex): Promise<Hex> {
  if (!PAYMASTER_RPC_URL) {
    throw new Error('NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL not set — needed for smart account')
  }

  // Dynamic import to avoid issues if permissionless not installed
  const { toSimpleSmartAccount } = await import('permissionless/accounts')
  const { entryPoint07Address } = await import('viem/account-abstraction')

  const publicClient = createPublicClient({
    chain: base,
    transport: http(PAYMASTER_RPC_URL),
  })

  const owner = privateKeyToAccount(privateKey)
  const account = await toSimpleSmartAccount({
    client: publicClient as any,
    owner,
    entryPoint: {
      address: entryPoint07Address,
      version: '0.7',
    },
  })

  return account.address
}

async function createSponsoredClient(privateKey: Hex) {
  if (!PAYMASTER_RPC_URL) {
    throw new Error('NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL not set')
  }

  const { createSmartAccountClient } = await import('permissionless')
  const { toSimpleSmartAccount } = await import('permissionless/accounts')
  const { createPimlicoClient } = await import('permissionless/clients/pimlico')
  const { entryPoint07Address } = await import('viem/account-abstraction')

  const publicClient = createPublicClient({
    chain: base,
    transport: http(PAYMASTER_RPC_URL),
  })

  const paymasterClient = createPimlicoClient({
    chain: base,
    transport: http(PAYMASTER_RPC_URL),
    entryPoint: {
      address: entryPoint07Address,
      version: '0.7',
    },
  })

  const owner = privateKeyToAccount(privateKey)
  const smartAccount = await toSimpleSmartAccount({
    client: publicClient as any,
    owner,
    entryPoint: {
      address: entryPoint07Address,
      version: '0.7',
    },
  })

  const client = createSmartAccountClient({
    account: smartAccount,
    chain: base,
    paymaster: paymasterClient,
    bundlerTransport: http(PAYMASTER_RPC_URL),
    userOperation: {
      estimateFeesPerGas: async () => {
        const gasPrice = await paymasterClient.getUserOperationGasPrice()
        return gasPrice.fast
      },
    },
  })

  return { client, address: smartAccount.address }
}

async function checkBaseUSDCBalance(address: Hex): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  })

  const balance = await publicClient.readContract({
    address: BASE_TOKEN_ADDRESS as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  })

  return balance
}

async function createZkp2pDeposit(burnerKey: Hex, amount: bigint) {
  const { Zkp2pClient, getContracts, SUPPORTED_CHAIN_IDS } = await import('@zkp2p/offramp-sdk')

  const CHAIN_ID = SUPPORTED_CHAIN_IDS.BASE_SEPOLIA
  const RUNTIME_ENV = 'staging' as const
  const { addresses } = getContracts(CHAIN_ID, RUNTIME_ENV)
  const USDC_ADDRESS = addresses.usdc as `0x${string}`
  const DEFAULT_CONVERSION_RATE = '1020000000000000000' // 1.02 (2% premium)

  log('ZKP2P', `USDC address (zkp2p): ${USDC_ADDRESS}`)
  log('ZKP2P', `Escrow address: ${addresses.escrow}`)
  log('ZKP2P', `Amount: ${formatUnits(amount, USDC_DECIMALS)} USDC`)
  log('ZKP2P', `Payment method: ${PAYMENT_METHOD}`)
  log('ZKP2P', `Payment tag: ${PAYMENT_TAG}`)
  log('ZKP2P', `Currency: ${CURRENCY}`)

  // Create sponsored smart account client
  log('ZKP2P', 'Creating sponsored smart account client...')
  const { client: smartAccountClient, address: smartAccountAddress } =
    await createSponsoredClient(burnerKey)
  log('ZKP2P', `Smart account address: ${smartAccountAddress}`)

  // Check balance on the smart account
  const balance = await checkBaseUSDCBalance(smartAccountAddress)
  log('ZKP2P', `Smart account USDC balance: ${formatUnits(balance, USDC_DECIMALS)}`)

  if (balance < amount) {
    throw new Error(
      `Insufficient USDC on smart account. ` +
      `Have: ${formatUnits(balance, USDC_DECIMALS)}, ` +
      `Need: ${formatUnits(amount, USDC_DECIMALS)}. ` +
      `Fund ${smartAccountAddress} with USDC on Base first (via bridge or direct transfer).`
    )
  }

  if (DRY_RUN) {
    log('ZKP2P', 'DRY RUN — skipping actual deposit creation')
    return { hash: '0x_dry_run' as Hex }
  }

  // Build deposit data based on payment method
  let depositData: Record<string, string>
  switch (PAYMENT_METHOD) {
    case 'revolut':
      depositData = { tag: PAYMENT_TAG.startsWith('@') ? PAYMENT_TAG : `@${PAYMENT_TAG}` }
      break
    case 'wise':
      depositData = { email: PAYMENT_TAG }
      break
    case 'venmo':
      depositData = { username: PAYMENT_TAG.replace('@', '') }
      break
  }

  // Create zkp2p client
  const zkp2pClient = new Zkp2pClient({
    walletClient: smartAccountClient as any,
    chainId: CHAIN_ID,
    runtimeEnv: RUNTIME_ENV,
    apiKey: process.env.NEXT_PUBLIC_ZKP2P_API_KEY,
  })

  const minIntentAmount = amount / 10n // 10% minimum
  const maxIntentAmount = amount

  log('ZKP2P', `Intent range: ${formatUnits(minIntentAmount, USDC_DECIMALS)} - ${formatUnits(maxIntentAmount, USDC_DECIMALS)} USDC`)
  log('ZKP2P', 'Creating deposit...')

  const result = await zkp2pClient.createDeposit({
    token: USDC_ADDRESS,
    amount,
    intentAmountRange: {
      min: minIntentAmount,
      max: maxIntentAmount,
    },
    processorNames: [PAYMENT_METHOD],
    depositData: [depositData],
    conversionRates: [[
      { currency: CURRENCY as any, conversionRate: DEFAULT_CONVERSION_RATE },
    ]],
  })

  log('ZKP2P', `Deposit tx hash: ${result.hash}`)
  return { hash: result.hash }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70))
  console.log('  zkzkp2p E2E Deposit Test')
  console.log('='.repeat(70))
  console.log()
  console.log(`  Stage:          ${STAGE}`)
  console.log(`  Amount:         ${DEPOSIT_AMOUNT} USDC`)
  console.log(`  Payment:        ${PAYMENT_METHOD} / ${PAYMENT_TAG}`)
  console.log(`  Currency:       ${CURRENCY}`)
  console.log(`  Skip bridge:    ${SKIP_BRIDGE}`)
  console.log(`  Dry run:        ${DRY_RUN}`)
  console.log(`  Paymaster:      ${PAYMASTER_RPC_URL ? 'configured' : 'NOT SET'}`)
  console.log(`  Base token:     ${BASE_TOKEN_ADDRESS || 'NOT SET'}`)
  console.log(`  Aztec token:    ${AZTEC_TOKEN_ADDRESS || 'NOT SET'}`)
  console.log()

  const amount = parseUnits(DEPOSIT_AMOUNT, USDC_DECIMALS)
  let burnerKey: Hex | undefined = BURNER_PRIVATE_KEY

  // =========================================================================
  // STAGE 1: Burner Derivation
  // =========================================================================
  if (STAGE === 'all' || STAGE === 'burner') {
    console.log('-'.repeat(70))
    console.log('  Stage 1: Burner Derivation')
    console.log('-'.repeat(70))

    if (!EVM_PRIVATE_KEY) {
      logError('BURNER', 'EVM_PRIVATE_KEY not set. Cannot derive burner.')
      if (STAGE === 'burner') process.exit(1)
    } else {
      try {
        const burner = await deriveBurner(EVM_PRIVATE_KEY)
        burnerKey = burner.privateKey

        logSuccess('BURNER', `Derived burner successfully`)
        console.log(`    EOA address:           ${burner.eoaAddress}`)
        console.log(`    Smart account address: ${burner.smartAccountAddress}`)
        console.log(`    Nonce:                 ${burner.nonce}`)
        console.log()

        // Check balance on smart account
        if (BASE_TOKEN_ADDRESS) {
          try {
            const balance = await checkBaseUSDCBalance(burner.smartAccountAddress)
            console.log(`    USDC balance (smart):  ${formatUnits(balance, USDC_DECIMALS)} USDC`)
          } catch (e: any) {
            console.log(`    USDC balance (smart):  (could not fetch: ${e.message})`)
          }
        }
        console.log()
      } catch (err) {
        logError('BURNER', 'Burner derivation failed', err)
        if (STAGE === 'burner') process.exit(1)
      }
    }

    if (STAGE === 'burner') {
      console.log('Done (burner stage only).')
      process.exit(0)
    }
  }

  // =========================================================================
  // STAGE 2: Bridge (Aztec → Base)
  // =========================================================================
  if ((STAGE === 'all' || STAGE === 'bridge') && !SKIP_BRIDGE) {
    console.log('-'.repeat(70))
    console.log('  Stage 2: Bridge (Aztec → Base)')
    console.log('-'.repeat(70))

    try {
      await checkBridgePrereqs()

      log('BRIDGE', '')
      log('BRIDGE', '⚠ The Substance Bridge SDK requires Azguard (browser extension).')
      log('BRIDGE', '  This stage cannot run from CLI.')
      log('BRIDGE', '')
      log('BRIDGE', '  To test the full flow:')
      log('BRIDGE', '    1. Run the frontend: cd frontend && pnpm dev')
      log('BRIDGE', '    2. Connect Azguard wallet in the browser')
      log('BRIDGE', '    3. Connect MetaMask for Base')
      log('BRIDGE', '    4. Create a deposit through the UI')
      log('BRIDGE', '')
      log('BRIDGE', '  To skip and test zkp2p directly:')

      if (burnerKey) {
        const sa = await getSmartAccountAddress(burnerKey)
        log('BRIDGE', `    Fund smart account ${sa} with USDC on Base`)
        log('BRIDGE', `    Then re-run with: SKIP_BRIDGE=1 BURNER_PRIVATE_KEY=${burnerKey} tsx scripts/test-deposit-e2e.ts`)
      } else {
        log('BRIDGE', '    Set SKIP_BRIDGE=1 and BURNER_PRIVATE_KEY=0x...')
      }

      console.log()
    } catch (err) {
      logError('BRIDGE', 'Bridge prereq check failed', err)
    }

    if (STAGE === 'bridge') {
      console.log('Done (bridge stage only).')
      process.exit(0)
    }
  } else if (SKIP_BRIDGE) {
    console.log('-'.repeat(70))
    console.log('  Stage 2: Bridge — SKIPPED (SKIP_BRIDGE=1)')
    console.log('-'.repeat(70))
    console.log()
  }

  // =========================================================================
  // STAGE 3: zkp2p Deposit (gasless via Paymaster)
  // =========================================================================
  if (STAGE === 'all' || STAGE === 'zkp2p') {
    console.log('-'.repeat(70))
    console.log('  Stage 3: zkp2p Deposit (gasless via Paymaster)')
    console.log('-'.repeat(70))

    if (!burnerKey) {
      logError('ZKP2P', 'No burner key available. Set BURNER_PRIVATE_KEY or run stage 1 first.')
      process.exit(1)
    }

    if (!PAYMASTER_RPC_URL) {
      logError('ZKP2P', 'NEXT_PUBLIC_COINBASE_PAYMASTER_RPC_URL not set.')
      process.exit(1)
    }

    if (!BASE_TOKEN_ADDRESS) {
      logError('ZKP2P', 'NEXT_PUBLIC_BASE_TOKEN_ADDRESS not set.')
      process.exit(1)
    }

    try {
      const result = await createZkp2pDeposit(burnerKey, amount)
      logSuccess('ZKP2P', `Deposit created!`)
      console.log(`    Tx hash: ${result.hash}`)
      console.log()
    } catch (err) {
      logError('ZKP2P', 'zkp2p deposit failed', err)
      process.exit(1)
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('='.repeat(70))
  console.log('  E2E Deposit Test Complete')
  console.log('='.repeat(70))
}

main().catch((err) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
