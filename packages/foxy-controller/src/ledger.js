import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { loadOrCreateSecret } from '../../foxy-security/src/index.js';

// Tokenomics parameters
export const TOKENOMICS_CONFIG = {
  TOKEN_SYMBOL: '$FOXY',
  UPTIME_RATE_PER_MINUTE: 0.25,        // 0.25 FOXY per minute online
  BANDWIDTH_RATE_PER_MB: 1.50,         // 1.50 FOXY per MB transferred
  DVPN_BANDWIDTH_RATE_PER_MB: 2.00,    // 2.00 FOXY per MB of encrypted dVPN traffic routed
  COMPUTE_RATE_PER_UNIT: 3.50,         // 3.50 FOXY per verified Foxy Compute Credit (FCC)
  EPOCH_DURATION_MS: 30000,            // 30 second settlement epochs
  TIER_MULTIPLIERS: {
    STANDARD: 1.0,
    HIGH_PERFORMANCE: 1.5,
    ULTRA_COMPUTE: 2.0
  }
};

// Traffic counters are reported by the node itself. Until the gateway meters
// them independently, cap what a single heartbeat can claim (≈100 Mbit/s).
export const MAX_REPORTED_BYTES_PER_SECOND = 12.5 * 1024 * 1024;

const HOUR_MS = 3600 * 1000;
const UPTIME_HISTORY_HOURS = 7 * 24;

/**
 * Loads the oracle signing key. It is an independent secret: it is never
 * derived from the network secret or from anything published in the repo.
 */
export function loadOracleWallet() {
  let key = loadOrCreateSecret('oracle-key', { envVar: 'FOXY_ORACLE_PRIVATE_KEY' });
  if (!key.startsWith('0x')) key = '0x' + key;
  return new ethers.Wallet(key);
}

function round4(n) {
  return parseFloat(n.toFixed(4));
}

export class FoxyLedger {
  /**
   * @param {object} options
   * @param {ethers.Wallet} [options.oracleWallet]
   * @param {object} [options.snapshot] previously persisted state
   * @param {() => void} [options.onChange] called whenever persistent state changes
   * @param {boolean} [options.autoSettle] run epoch settlement on a timer
   */
  constructor({ oracleWallet = null, snapshot = null, onChange = () => {}, autoSettle = true } = {}) {
    this.accounts = new Map(); // nodeId -> account
    this.claimNonces = new Map(); // recipient address (lowercase) -> next on-chain nonce
    this.networkTotalMinted = 0;
    this.networkTotalBurned = 0;
    this.totalComputeUnitsProcessed = 0;
    this.currentEpoch = 1;
    this.onChange = onChange;
    this.oracleWallet = oracleWallet || loadOracleWallet();

    if (snapshot) this.restore(snapshot);

    console.log(`[Tokenomics 🦊] Controller Oracle Web3 Address: ${this.oracleWallet.address}`);

    if (autoSettle) {
      this.epochTimer = setInterval(() => this.settleEpoch(), TOKENOMICS_CONFIG.EPOCH_DURATION_MS);
      this.epochTimer.unref();
    }
  }

  serialize() {
    return {
      currentEpoch: this.currentEpoch,
      networkTotalMinted: this.networkTotalMinted,
      networkTotalBurned: this.networkTotalBurned,
      totalComputeUnitsProcessed: this.totalComputeUnitsProcessed,
      accounts: Array.from(this.accounts.values()),
      claimNonces: Object.fromEntries(this.claimNonces)
    };
  }

  restore(snapshot) {
    this.currentEpoch = snapshot.currentEpoch || 1;
    this.networkTotalMinted = snapshot.networkTotalMinted || 0;
    this.networkTotalBurned = snapshot.networkTotalBurned || 0;
    this.totalComputeUnitsProcessed = snapshot.totalComputeUnitsProcessed || 0;
    for (const acc of snapshot.accounts || []) {
      if (acc && acc.nodeId) this.accounts.set(acc.nodeId, { ...this.newAccount(acc.nodeId), ...acc });
    }
    for (const [addr, nonce] of Object.entries(snapshot.claimNonces || {})) {
      this.claimNonces.set(addr, nonce);
    }
  }

  newAccount(nodeId) {
    return {
      nodeId,
      walletAddress: null,
      balance: 0,
      pendingUptimeSeconds: 0,
      pendingBytesServed: 0,
      pendingVpnBytes: 0,
      pendingComputeUnits: 0,
      lifetimeEarnings: 0,
      lifetimeComputeUnits: 0,
      burnedTokens: 0,
      tier: 'STANDARD',
      epochsSettled: 0,
      firstSeenAt: Date.now(),
      uptimeByHour: {}, // hour index -> seconds online in that hour
      recentPayouts: []
    };
  }

  hasAccount(nodeId) {
    return this.accounts.has(nodeId);
  }

  getAccount(nodeId, walletAddress = null) {
    if (!this.accounts.has(nodeId)) {
      this.accounts.set(nodeId, this.newAccount(nodeId));
      this.onChange();
    }
    const acc = this.accounts.get(nodeId);
    if (walletAddress && ethers.isAddress(walletAddress)) {
      const normalized = ethers.getAddress(walletAddress);
      if (acc.walletAddress !== normalized) {
        acc.walletAddress = normalized;
        this.onChange();
      }
    }
    return acc;
  }

  recordActivity(nodeId, { uptimeDeltaSeconds = 0, bytesDelta = 0, vpnBytesDelta = 0, specs = {}, walletAddress = null }) {
    const account = this.getAccount(nodeId, walletAddress);

    // Determine performance tier based on donated specs
    if (specs.cores >= 8 || specs.totalRamMb >= 16384) {
      account.tier = 'ULTRA_COMPUTE';
    } else if (specs.cores >= 4 || specs.totalRamMb >= 8192) {
      account.tier = 'HIGH_PERFORMANCE';
    } else {
      account.tier = 'STANDARD';
    }

    const uptime = Math.max(0, Number(uptimeDeltaSeconds) || 0);
    const byteCap = Math.max(1, uptime) * MAX_REPORTED_BYTES_PER_SECOND;
    account.pendingUptimeSeconds += uptime;
    account.pendingBytesServed += Math.min(Math.max(0, Number(bytesDelta) || 0), byteCap);
    account.pendingVpnBytes += Math.min(Math.max(0, Number(vpnBytesDelta) || 0), byteCap);

    if (uptime > 0) {
      const hour = Math.floor(Date.now() / HOUR_MS);
      account.uptimeByHour[hour] = Math.min(3600, (account.uptimeByHour[hour] || 0) + uptime);
      for (const key of Object.keys(account.uptimeByHour)) {
        if (Number(key) < hour - UPTIME_HISTORY_HOURS) delete account.uptimeByHour[key];
      }
    }
    this.onChange();
  }

  /** Credits compute units for a partner job whose result was accepted. */
  recordCompute(nodeId, computeUnits) {
    const account = this.getAccount(nodeId);
    const units = Math.max(0, Number(computeUnits) || 0);
    account.pendingComputeUnits += units;
    account.lifetimeComputeUnits += units;
    this.totalComputeUnitsProcessed += units;
    this.onChange();
  }

  /**
   * Spends (burns) part of a node's unclaimed balance to pay for a service.
   * This is the off-chain ledger balance: tokens already minted on-chain are
   * paid through FoxyTreasuryVault.paySubscriptionWithFoxy() instead.
   */
  burnForService(nodeId, amountFoxy, reason = 'SERVICE') {
    const account = this.accounts.get(nodeId);
    const amount = round4(Number(amountFoxy));
    if (!account || !(amount > 0)) return { success: false, error: 'Importe inválido' };
    if (account.balance < amount) {
      return { success: false, error: `Saldo insuficiente: ${account.balance} $FOXY disponibles, ${amount} requeridos` };
    }
    account.balance = round4(account.balance - amount);
    account.burnedTokens = round4((account.burnedTokens || 0) + amount);
    this.networkTotalBurned = round4(this.networkTotalBurned + amount);
    this.onChange();
    return { success: true, amount, reason, balance: account.balance };
  }

  /**
   * Fraction of time the node was online over the last `hours` hours
   * (or since it was first seen, if that is more recent).
   */
  getUptimeRatio(nodeId, hours = 24) {
    const account = this.accounts.get(nodeId);
    if (!account) return 0;
    const now = Date.now();
    const currentHour = Math.floor(now / HOUR_MS);
    let onlineSeconds = 0;
    for (const [key, seconds] of Object.entries(account.uptimeByHour)) {
      if (Number(key) > currentHour - hours) onlineSeconds += seconds;
    }
    const windowSeconds = Math.min(hours * 3600, Math.max(60, (now - account.firstSeenAt) / 1000));
    return Math.min(1, onlineSeconds / windowSeconds);
  }

  settleEpoch() {
    this.currentEpoch++;
    const now = new Date().toISOString();

    for (const [nodeId, account] of this.accounts.entries()) {
      if (account.pendingUptimeSeconds <= 0 && account.pendingBytesServed <= 0 &&
          account.pendingVpnBytes <= 0 && account.pendingComputeUnits <= 0) {
        continue;
      }

      const multiplier = TOKENOMICS_CONFIG.TIER_MULTIPLIERS[account.tier] || 1.0;

      const uptimeMinutes = account.pendingUptimeSeconds / 60;
      const uptimeReward = uptimeMinutes * TOKENOMICS_CONFIG.UPTIME_RATE_PER_MINUTE * multiplier;

      const megabytes = account.pendingBytesServed / (1024 * 1024);
      const bandwidthReward = megabytes * TOKENOMICS_CONFIG.BANDWIDTH_RATE_PER_MB * multiplier;

      const vpnMegabytes = account.pendingVpnBytes / (1024 * 1024);
      const vpnReward = vpnMegabytes * TOKENOMICS_CONFIG.DVPN_BANDWIDTH_RATE_PER_MB * multiplier;

      // Compute units are already sized by the work done: no hardware multiplier.
      const computeReward = account.pendingComputeUnits * TOKENOMICS_CONFIG.COMPUTE_RATE_PER_UNIT;

      const totalEpochReward = round4(uptimeReward + bandwidthReward + vpnReward + computeReward);

      if (totalEpochReward > 0) {
        account.balance = round4(account.balance + totalEpochReward);
        account.lifetimeEarnings = round4(account.lifetimeEarnings + totalEpochReward);
        this.networkTotalMinted = round4(this.networkTotalMinted + totalEpochReward);
        account.epochsSettled++;

        account.recentPayouts.unshift({
          epoch: this.currentEpoch,
          timestamp: now,
          reward: totalEpochReward,
          breakdown: {
            uptimeSeconds: account.pendingUptimeSeconds,
            uptimeReward: round4(uptimeReward),
            bytesServed: account.pendingBytesServed,
            bandwidthReward: round4(bandwidthReward),
            vpnBytesServed: account.pendingVpnBytes,
            vpnReward: round4(vpnReward),
            computeUnits: account.pendingComputeUnits,
            computeReward: round4(computeReward),
            tier: account.tier,
            multiplier
          },
          receiptHash: crypto.createHash('sha256').update(`${nodeId}-${this.currentEpoch}-${totalEpochReward}-${now}`).digest('hex').slice(0, 16)
        });
        if (account.recentPayouts.length > 20) account.recentPayouts.pop();
      }

      account.pendingUptimeSeconds = 0;
      account.pendingBytesServed = 0;
      account.pendingVpnBytes = 0;
      account.pendingComputeUnits = 0;
    }
    this.onChange();
  }

  /**
   * Signs a reward voucher that the recipient can redeem on-chain with
   * FoxyToken.claimContributionReward(amount, epoch, signature).
   *
   * Nothing is transferred here: the tokens are minted only when the recipient
   * submits the voucher to the contract. `chainId` and `contractAddress` must
   * match the deployed FoxyToken or the contract will reject the signature.
   */
  async claimRewards(nodeId, targetAddress = null, { chainId = null, contractAddress = null } = {}) {
    const account = this.accounts.get(nodeId);
    if (!account || account.balance <= 0) {
      return { success: false, error: 'No claimable balance available' };
    }

    const candidate = targetAddress || account.walletAddress;
    if (!candidate || !ethers.isAddress(candidate)) {
      return { success: false, error: 'A valid EVM payout address is required' };
    }
    const recipient = ethers.getAddress(candidate);

    const resolvedChainId = Number(chainId ?? process.env.FOXY_CHAIN_ID ?? 84532);
    const configuredContract = contractAddress || process.env.FOXY_TOKEN_ADDRESS || null;
    const onChain = !!configuredContract && ethers.isAddress(configuredContract);
    const resolvedContract = onChain ? ethers.getAddress(configuredContract) : ethers.ZeroAddress;

    const claimedAmount = account.balance;
    const amountWei = ethers.parseEther(claimedAmount.toFixed(4));

    // The contract tracks one nonce per recipient (msg.sender), so we do too.
    const nonceKey = recipient.toLowerCase();
    const nonce = this.claimNonces.get(nonceKey) || 0;

    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint256', 'uint256', 'uint256', 'address'],
      [recipient, amountWei, this.currentEpoch, nonce, resolvedChainId, resolvedContract]
    );
    const signature = await this.oracleWallet.signMessage(ethers.getBytes(messageHash));

    // Only mutate state once the signature exists.
    account.balance = 0;
    // A simulated voucher never reaches a contract, so it must not consume an
    // on-chain nonce.
    if (onChain) this.claimNonces.set(nonceKey, nonce + 1);
    this.onChange();

    return {
      success: true,
      amount: claimedAmount,
      receipt: {
        claimId: crypto.randomUUID(),
        settlement: onChain ? 'ONCHAIN_VOUCHER' : 'SIMULATED',
        note: onChain
          ? 'Voucher firmado. Envíalo a FoxyToken.claimContributionReward() para acuñar los tokens.'
          : 'Modo simulación: no hay contrato FoxyToken configurado (FOXY_TOKEN_ADDRESS). No se transfirió ningún token.',
        amount: claimedAmount,
        amountWei: amountWei.toString(),
        symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
        oracle: this.oracleWallet.address,
        to: recipient,
        epoch: this.currentEpoch,
        nonce,
        chainId: resolvedChainId,
        contractAddress: onChain ? resolvedContract : null,
        signature,
        timestamp: new Date().toISOString()
      }
    };
  }

  getLeaderboard() {
    return Array.from(this.accounts.values())
      .sort((a, b) => b.lifetimeEarnings - a.lifetimeEarnings)
      .slice(0, 10)
      .map((acc, index) => ({
        rank: index + 1,
        nodeId: acc.nodeId,
        walletAddress: acc.walletAddress,
        balance: acc.balance,
        lifetimeEarnings: acc.lifetimeEarnings,
        tier: acc.tier,
        epochsSettled: acc.epochsSettled
      }));
  }
}
