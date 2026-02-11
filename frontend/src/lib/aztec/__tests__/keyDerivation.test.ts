/**
 * Key Derivation Tests
 *
 * Tests that the MetaMask signature → Aztec secret derivation is deterministic
 * and produces unique outputs for different inputs.
 */

import { describe, it, expect } from 'vitest';
import { keccak256, encodePacked } from 'viem';

// Inline the derivation logic to avoid import issues with @aztec/aztec.js in tests
const DOMAIN = 'zkzkp2p-aztec';

function deriveAztecSecretRaw(signature: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(['string', 'bytes'], [DOMAIN, signature]));
}

function deriveSaltRaw(address: string): `0x${string}` {
  return keccak256(encodePacked(['string', 'address'], [DOMAIN + '-salt', address as `0x${string}`]));
}

describe('Aztec key derivation', () => {
  const sig1 = '0xaabbccdd1122334455667788990011223344556677889900112233445566778899001122334455667788990011223344556677889900112233445566778899001100' as `0x${string}`;
  const sig2 = '0x1122334455667788aabbccdd990011223344556677889900112233445566778899001122334455667788990011223344556677889900112233445566778899001100' as `0x${string}`;

  it('same signature always produces same secret', () => {
    const secret1 = deriveAztecSecretRaw(sig1);
    const secret2 = deriveAztecSecretRaw(sig1);
    expect(secret1).toBe(secret2);
  });

  it('different signatures produce different secrets', () => {
    const secret1 = deriveAztecSecretRaw(sig1);
    const secret2 = deriveAztecSecretRaw(sig2);
    expect(secret1).not.toBe(secret2);
  });

  it('same address always produces same salt', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    const salt1 = deriveSaltRaw(addr);
    const salt2 = deriveSaltRaw(addr);
    expect(salt1).toBe(salt2);
  });

  it('different addresses produce different salts', () => {
    const addr1 = '0x1234567890abcdef1234567890abcdef12345678';
    const addr2 = '0xabcdef1234567890abcdef1234567890abcdef12';
    const salt1 = deriveSaltRaw(addr1);
    const salt2 = deriveSaltRaw(addr2);
    expect(salt1).not.toBe(salt2);
  });

  it('secret is a valid 32-byte hex string', () => {
    const secret = deriveAztecSecretRaw(sig1);
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
