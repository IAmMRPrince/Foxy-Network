import crypto from 'node:crypto';

// Tokenomics parameters
export const TOKENOMICS_CONFIG = {
  TOKEN_SYMBOL: '$FOXY',
  UPTIME_RATE_PER_MINUTE: 0.25,        // 0.25 FOXY per minute online
  BANDWIDTH_RATE_PER_MB: 1.50,         // 1.50 FOXY per MB transferred
  EPOCH_DURATION_MS: 30000,            // 30 second settlement epochs
  TIER_MULTIPLIERS: {
    STANDARD: 1.0,
    HIGH_PERFORMANCE: 1.5,
    ULTRA_COMPUTE: 2.0
  }
};

export class FoxyLedger {
  constructor() {
    this.accounts = new Map(); // nodeId -> { nodeId, walletAddress, balance, pendingUptime, pendingBytes, lifetimeEarnings, epochsCount, history: [] }
    this.networkTotalMinted = 0;
    this.currentEpoch = 1;

    // Start automated epoch settlement
    this.epochTimer = setInterval(() => this.settleEpoch(), TOKENOMICS_CONFIG.EPOCH_DURATION_MS);
  }

  getAccount(nodeId, walletAddress = null) {
    if (!this.accounts.has(nodeId)) {
      this.accounts.set(nodeId, {
        nodeId,
        walletAddress: walletAddress || `foxy_wallet_${crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 16)}`,
        balance: 0,
        pendingUptimeSeconds: 0,
        pendingBytesServed: 0,
        lifetimeEarnings: 0,
        tier: 'STANDARD',
        epochsSettled: 0,
        recentPayouts: []
      });
    }
    return this.accounts.get(nodeId);
  }

  recordActivity(nodeId, { uptimeDeltaSeconds = 0, bytesDelta = 0, specs = {} }) {
    const account = this.getAccount(nodeId);

    // Determine performance tier based on donated specs
    if (specs.cores >= 8 || specs.totalRamMb >= 16384) {
      account.tier = 'ULTRA_COMPUTE';
    } else if (specs.cores >= 4 || specs.totalRamMb >= 8192) {
      account.tier = 'HIGH_PERFORMANCE';
    } else {
      account.tier = 'STANDARD';
    }

    account.pendingUptimeSeconds += uptimeDeltaSeconds;
    account.pendingBytesServed += bytesDelta;
  }

  settleEpoch() {
    this.currentEpoch++;
    const now = new Date().toISOString();

    for (const [nodeId, account] of this.accounts.entries()) {
      if (account.pendingUptimeSeconds <= 0 && account.pendingBytesServed <= 0) {
        continue;
      }

      const multiplier = TOKENOMICS_CONFIG.TIER_MULTIPLIERS[account.tier] || 1.0;

      // 1. Calculate Uptime Reward
      const uptimeMinutes = account.pendingUptimeSeconds / 60;
      const uptimeReward = uptimeMinutes * TOKENOMICS_CONFIG.UPTIME_RATE_PER_MINUTE * multiplier;

      // 2. Calculate Bandwidth Reward
      const megabytes = account.pendingBytesServed / (1024 * 1024);
      const bandwidthReward = megabytes * TOKENOMICS_CONFIG.BANDWIDTH_RATE_PER_MB * multiplier;

      const totalEpochReward = parseFloat((uptimeReward + bandwidthReward).toFixed(4));

      if (totalEpochReward > 0) {
        account.balance = parseFloat((account.balance + totalEpochReward).toFixed(4));
        account.lifetimeEarnings = parseFloat((account.lifetimeEarnings + totalEpochReward).toFixed(4));
        this.networkTotalMinted = parseFloat((this.networkTotalMinted + totalEpochReward).toFixed(4));
        account.epochsSettled++;

        const payoutReceipt = {
          epoch: this.currentEpoch,
          timestamp: now,
          reward: totalEpochReward,
          breakdown: {
            uptimeSeconds: account.pendingUptimeSeconds,
            uptimeReward: parseFloat(uptimeReward.toFixed(4)),
            bytesServed: account.pendingBytesServed,
            bandwidthReward: parseFloat(bandwidthReward.toFixed(4)),
            tier: account.tier,
            multiplier
          },
          receiptHash: crypto.createHash('sha256').update(`${nodeId}-${this.currentEpoch}-${totalEpochReward}-${now}`).digest('hex').slice(0, 16)
        };

        account.recentPayouts.unshift(payoutReceipt);
        if (account.recentPayouts.length > 20) account.recentPayouts.pop();

        console.log(`[Tokenomics 💰] Epoch ${this.currentEpoch} Settled for ${nodeId}: +${totalEpochReward} ${TOKENOMICS_CONFIG.TOKEN_SYMBOL} (Balance: ${account.balance})`);
      }

      // Reset pending
      account.pendingUptimeSeconds = 0;
      account.pendingBytesServed = 0;
    }
  }

  claimRewards(nodeId, targetAddress) {
    const account = this.getAccount(nodeId);
    if (account.balance <= 0) {
      return { success: false, error: 'No claimable balance available' };
    }

    const claimedAmount = account.balance;
    account.balance = 0;

    const txReceipt = {
      txHash: '0x' + crypto.randomBytes(32).toString('hex'),
      amount: claimedAmount,
      symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
      from: 'Foxy Network Rewards Treasury',
      to: targetAddress || account.walletAddress,
      timestamp: new Date().toISOString(),
      network: 'Foxy L2 Sovereign Rollup'
    };

    return {
      success: true,
      amount: claimedAmount,
      receipt: txReceipt
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
