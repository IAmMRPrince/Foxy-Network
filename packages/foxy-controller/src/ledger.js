import crypto from 'node:crypto';
import { ethers } from 'ethers';

// Tokenomics parameters
export const TOKENOMICS_CONFIG = {
  TOKEN_SYMBOL: '$FOXY',
  UPTIME_RATE_PER_MINUTE: 0.25,        // 0.25 FOXY per minute online
  BANDWIDTH_RATE_PER_MB: 1.50,         // 1.50 FOXY per MB transferred
  DVPN_BANDWIDTH_RATE_PER_MB: 2.00,    // 2.00 FOXY per MB of encrypted dVPN traffic routed
  EPOCH_DURATION_MS: 30000,            // 30 second settlement epochs
  TIER_MULTIPLIERS: {
    STANDARD: 1.0,
    HIGH_PERFORMANCE: 1.5,
    ULTRA_COMPUTE: 2.0
  }
};

export class FoxyLedger {
  constructor(sharedSecret = 'foxy-depin-cluster-shared-secret-v1') {
    this.accounts = new Map(); // nodeId -> { nodeId, walletAddress, balance, pendingUptime, pendingBytes, pendingVpnBytes, lifetimeEarnings, epochsCount, history: [] }
    this.networkTotalMinted = 0;
    this.currentEpoch = 1;

    // Deterministic Controller Oracle Key (used to sign on-chain reward claims)
    const seed = crypto.createHash('sha256').update(`${sharedSecret}-oracle-master-key-v1`).digest('hex');
    this.oracleWallet = new ethers.Wallet('0x' + seed);
    console.log(`[Tokenomics 🦊] Controller Oracle Web3 Address: ${this.oracleWallet.address}`);

    // Start automated epoch settlement
    this.epochTimer = setInterval(() => this.settleEpoch(), TOKENOMICS_CONFIG.EPOCH_DURATION_MS);
  }

  getAccount(nodeId, walletAddress = null) {
    if (!this.accounts.has(nodeId)) {
      this.accounts.set(nodeId, {
        nodeId,
        walletAddress: walletAddress || `0x${crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 40)}`,
        balance: 0,
        pendingUptimeSeconds: 0,
        pendingBytesServed: 0,
        pendingVpnBytes: 0,
        lifetimeEarnings: 0,
        tier: 'STANDARD',
        epochsSettled: 0,
        nonce: 0,
        recentPayouts: []
      });
    } else if (walletAddress && walletAddress.startsWith('0x')) {
      const acc = this.accounts.get(nodeId);
      acc.walletAddress = walletAddress;
    }
    return this.accounts.get(nodeId);
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

    account.pendingUptimeSeconds += uptimeDeltaSeconds;
    account.pendingBytesServed += bytesDelta;
    account.pendingVpnBytes += vpnBytesDelta;
  }

  settleEpoch() {
    this.currentEpoch++;
    const now = new Date().toISOString();

    for (const [nodeId, account] of this.accounts.entries()) {
      if (account.pendingUptimeSeconds <= 0 && account.pendingBytesServed <= 0 && account.pendingVpnBytes <= 0) {
        continue;
      }

      const multiplier = TOKENOMICS_CONFIG.TIER_MULTIPLIERS[account.tier] || 1.0;

      // 1. Calculate Uptime Reward
      const uptimeMinutes = account.pendingUptimeSeconds / 60;
      const uptimeReward = uptimeMinutes * TOKENOMICS_CONFIG.UPTIME_RATE_PER_MINUTE * multiplier;

      // 2. Calculate Standard Cloud Bandwidth Reward
      const megabytes = account.pendingBytesServed / (1024 * 1024);
      const bandwidthReward = megabytes * TOKENOMICS_CONFIG.BANDWIDTH_RATE_PER_MB * multiplier;

      // 3. Calculate Encrypted dVPN Routing Reward
      const vpnMegabytes = account.pendingVpnBytes / (1024 * 1024);
      const vpnReward = vpnMegabytes * TOKENOMICS_CONFIG.DVPN_BANDWIDTH_RATE_PER_MB * multiplier;

      const totalEpochReward = parseFloat((uptimeReward + bandwidthReward + vpnReward).toFixed(4));

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
            vpnBytesServed: account.pendingVpnBytes,
            vpnReward: parseFloat(vpnReward.toFixed(4)),
            tier: account.tier,
            multiplier
          },
          receiptHash: crypto.createHash('sha256').update(`${nodeId}-${this.currentEpoch}-${totalEpochReward}-${now}`).digest('hex').slice(0, 16)
        };

        account.recentPayouts.unshift(payoutReceipt);
        if (account.recentPayouts.length > 20) account.recentPayouts.pop();

        console.log(`[Tokenomics 💰] Epoch ${this.currentEpoch} Settled for ${nodeId} (${account.walletAddress.slice(0, 8)}...): +${totalEpochReward} ${TOKENOMICS_CONFIG.TOKEN_SYMBOL} (Balance: ${account.balance})`);
      }

      // Reset pending
      account.pendingUptimeSeconds = 0;
      account.pendingBytesServed = 0;
      account.pendingVpnBytes = 0;
    }
  }

  async claimRewards(nodeId, targetAddress = null, chainId = 84532, contractAddress = '0x1111111111111111111111111111111111111111') {
    const account = this.getAccount(nodeId);
    if (account.balance <= 0) {
      return { success: false, error: 'No claimable balance available' };
    }

    const claimedAmount = account.balance;
    const recipient = targetAddress && targetAddress.startsWith('0x') ? targetAddress : account.walletAddress;
    account.balance = 0;
    account.nonce++;

    // Calculate 18 decimals Wei amount
    const amountWei = ethers.parseEther(claimedAmount.toFixed(4));

    // Sign message for FoxyToken.sol claimContributionReward(amount, epoch, signature)
    const messageHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'uint256', 'uint256', 'uint256', 'address'],
      [recipient, amountWei, this.currentEpoch, account.nonce - 1, chainId, contractAddress]
    );

    const signature = await this.oracleWallet.signMessage(ethers.getBytes(messageHash));

    const txReceipt = {
      txHash: '0x' + crypto.randomBytes(32).toString('hex'),
      amount: claimedAmount,
      amountWei: amountWei.toString(),
      symbol: TOKENOMICS_CONFIG.TOKEN_SYMBOL,
      from: this.oracleWallet.address,
      to: recipient,
      epoch: this.currentEpoch,
      nonce: account.nonce - 1,
      signature,
      timestamp: new Date().toISOString(),
      network: 'Foxy DePIN Multi-Chain Settler (Base / Polygon / Arbitrum)'
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
