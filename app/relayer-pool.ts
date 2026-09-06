import { keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_MIN_BALANCE_WEI = 10_000_000_000_000n;

function configuredKeys(): Hex[] {
  const values = [
    process.env.VOIDDEX_RELAYER_PRIVATE_KEYS,
    process.env.VOIDDEX_RELAYER_PRIVATE_KEY,
    process.env.PAYMASTER_RELAYER_PRIVATE_KEY,
  ].filter(Boolean).join(',').split(',').map((value) => value.trim());
  return [...new Set(values.filter((value) => PRIVATE_KEY.test(value)))] as Hex[];
}

export function relayerPoolConfigured(): boolean {
  return configuredKeys().length > 0;
}

function minimumBalance(): bigint {
  const configured = process.env.RELAYER_MIN_ETH_WEI;
  return configured && /^\d+$/.test(configured) ? BigInt(configured) : DEFAULT_MIN_BALANCE_WEI;
}

/** Selects a funded hot relayer while the Paymaster remains the nonce authority. */
export async function selectRelayer(client: PublicClient, entropy: string): Promise<PrivateKeyAccount> {
  const accounts = configuredKeys().map((key) => privateKeyToAccount(key));
  if (accounts.length === 0) throw new Error('No DEX relayer key is configured.');
  const balances = await Promise.all(accounts.map(async (account) => {
    try { return { account, balance: await client.getBalance({ address: account.address }) }; }
    catch { return { account, balance: -1n }; }
  }));
  const healthy = balances.filter(({ balance }) => balance >= minimumBalance());
  if (healthy.length === 0) throw new Error('Every DEX relayer is unavailable or below its ETH reserve floor.');
  const seed = BigInt(keccak256(toHex(entropy)));
  return healthy[Number(seed % BigInt(healthy.length))]!.account;
}
