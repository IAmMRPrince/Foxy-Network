import crypto from 'node:crypto';
import { ethers } from 'ethers';

// Tokenomics parameters
export const TOKENOMICS_CONFIG = {
  TOKEN_SYMBOL: '$FOXY',
  UPTIME_RATE_PER_MINUTE: 0.25,        // 0.25 FOXY per minute online
  BANDWIDTH_RATE_PER_MB: 1.50,         // 1.50 FOXY per MB transferred
  DVPN_BANDWIDTH_RATE_PER_MB: 2.00,    // 2.00 FOXY per MB of encrypted dVPN traffic routed
  COMPUTE_UNIT_RATE_FOXY: 3.50,        // 3.50 FOXY per Foxy Compute Credit (FCC) unit verified for Foxy Finance
  EPOCH_DURATION_MS: 30000,            // 30 second settlement epochs
  TIER_MULTIPLIERS: {
    STANDARD: 1.0,
    HIGH_PERFORMANCE: 1.5,
    ULTRA_COMPUTE: 2.0
  },
  FOXY_FINANCE_HARDWARE_MATRIX: {
    ESP32_IOT: {
      discountPercent: 15,
      freeProQuant: false,
      minCores: 1,
      minRamMb: 0,
      label: 'ESP32 / Microcontrolador IoT'
    },
    ANDROID_EDGE: {
      discountPercent: 25,
      freeProQuant: false,
      minCores: 2,
      minRamMb: 1024,
      label: 'Celular Android (Termux / Edge)'
    },
    SBC_RASPBERRY: {
      discountPercent: 50,
      freeProQuant: false,
      minCores: 4,
      minRamMb: 2048,
      label: 'Raspberry Pi 3/4/5 / SBC'
    },
    DESKTOP_PC: {
      discountPercent: 70,
      freeProQuant: false,
      minCores: 4,
      minRamMb: 8192,
      label: 'Computador Personal / Laptop'
    },
    VPS_BAREMETAL: {
      discountPercent: 100,
      freeProQuant: true,
      minCores: 8,
      minRamMb: 16384,
      label: 'Servidor VPS / Bare Metal (Pro Quant GRATIS)'
    }
  }
};

export class FoxyLedger {
  constructor(sharedSecret = 'foxy-depin-cluster-shared-secret-v1') {
    this.accounts = new Map(); // nodeId -> account
    this.tenantBindings = new Map(); // tenantUserId -> { tenantUserId, nodeId, walletAddress, linkedAt }
    this.networkTotalMinted = 0;
    this.networkTotalBurned = 0;
    this.totalComputeUnitsProcessed = 0;
    this.currentEpoch = 1;

    // Deterministic Controller Oracle Key (used to sign on-chain reward claims)
    const seed = crypto.createHash('sha256').update(`${sharedSecret}-oracle-master-key-v1`).digest('hex');
    this.oracleWallet = new ethers.Wallet('0x' + seed);
    console.log(`[Tokenomics 🦊] Controller Oracle Web3 Address: ${this.oracleWallet.address}`);

    // Start automated epoch settlement
    this.epochTimer = setInterval(() => this.settleEpoch(), TOKENOMICS_CONFIG.EPOCH_DURATION_MS);
  }

  classifyHardwareForFoxyFinance(specs = {}) {
    const explicitType = String(specs.deviceType || specs.hardwareClass || '').toUpperCase();
    const matrix = TOKENOMICS_CONFIG.FOXY_FINANCE_HARDWARE_MATRIX;

    if (matrix[explicitType]) {
      return { hardwareClass: explicitType, ...matrix[explicitType] };
    }

    const cores = Number(specs.cores || 2);
    const ramMb = Number(specs.totalRamMb || 2048);
    const arch = String(specs.arch || '').toLowerCase();
    const platform = String(specs.platform || '').toLowerCase();

    if (explicitType.includes('ESP32') || explicitType.includes('IOT') || ramMb <= 512) {
      return { hardwareClass: 'ESP32_IOT', ...matrix.ESP32_IOT };
    }
    if (platform === 'android' || explicitType.includes('ANDROID') || explicitType.includes('TERMUX')) {
      return { hardwareClass: 'ANDROID_EDGE', ...matrix.ANDROID_EDGE };
    }
    if ((arch.includes('arm') && ramMb <= 8192 && platform === 'linux') || explicitType.includes('RASPBERRY') || explicitType.includes('SBC')) {
      return { hardwareClass: 'SBC_RASPBERRY', ...matrix.SBC_RASPBERRY };
    }
    if (cores >= 8 && ramMb >= 16384) {
      return { hardwareClass: 'VPS_BAREMETAL', ...matrix.VPS_BAREMETAL };
    }
    return { hardwareClass: 'DESKTOP_PC', ...matrix.DESKTOP_PC };
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
        pendingComputeUnits: 0,
        lifetimeEarnings: 0,
        lifetimeComputeUnits: 0,
        burnedTokens: 0,
        linkedTenantUserId: null,
        hardwareClass: 'DESKTOP_PC',
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

  recordActivity(nodeId, { uptimeDeltaSeconds = 0, bytesDelta = 0, vpnBytesDelta = 0, computeUnitsDelta = 0, specs = {}, walletAddress = null }) {
    const account = this.getAccount(nodeId, walletAddress);

    // Determine performance tier based on donated specs
    if (specs.cores >= 8 || specs.totalRamMb >= 16384) {
      account.tier = 'ULTRA_COMPUTE';
    } else if (specs.cores >= 4 || specs.totalRamMb >= 8192) {
      account.tier = 'HIGH_PERFORMANCE';
    } else {
      account.tier = 'STANDARD';
    }

    if (specs && Object.keys(specs).length > 0) {
      const hw = this.classifyHardwareForFoxyFinance(specs);
      account.hardwareClass = hw.hardwareClass;
    }

    account.pendingUptimeSeconds += uptimeDeltaSeconds;
    account.pendingBytesServed += bytesDelta;
    account.pendingVpnBytes += vpnBytesDelta;
    account.pendingComputeUnits += computeUnitsDelta;
  }

  settleEpoch() {
    this.currentEpoch++;
    const now = new Date().toISOString();

    for (const [nodeId, account] of this.accounts.entries()) {
      if (
        account.pendingUptimeSeconds <= 0 &&
        account.pendingBytesServed <= 0 &&
        account.pendingVpnBytes <= 0 &&
        account.pendingComputeUnits <= 0
      ) {
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

      // 4. Calculate Foxy Finance Verified Compute (FCC) Reward
      const computeUnits = account.pendingComputeUnits || 0;
      const computeReward = computeUnits * TOKENOMICS_CONFIG.COMPUTE_UNIT_RATE_FOXY * multiplier;

      const totalEpochReward = parseFloat((uptimeReward + bandwidthReward + vpnReward + computeReward).toFixed(4));

      if (totalEpochReward > 0) {
        account.balance = parseFloat((account.balance + totalEpochReward).toFixed(4));
        account.lifetimeEarnings = parseFloat((account.lifetimeEarnings + totalEpochReward).toFixed(4));
        account.lifetimeComputeUnits += computeUnits;
        this.totalComputeUnitsProcessed += computeUnits;
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
            computeUnits,
            computeReward: parseFloat(computeReward.toFixed(4)),
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
      account.pendingComputeUnits = 0;
    }
  }

  bindTenantUser(nodeId, tenantUserId, walletAddress = null, specs = {}) {
    if (!nodeId || !tenantUserId) {
      throw new Error('nodeId and tenantUserId are required');
    }
    const cleanUserId = String(tenantUserId).trim();
    const account = this.getAccount(nodeId, walletAddress);

    // Anti-IDOR check 1: Node cannot be hijacked by another tenant
    if (account.linkedTenantUserId && account.linkedTenantUserId !== cleanUserId) {
      throw new Error(
        `Anti-IDOR Violation: Node '${nodeId}' is already bound to tenant '${account.linkedTenantUserId}'`
      );
    }

    // Anti-IDOR check 2: If tenant is already bound to a different node owned by another wallet, verify ownership
    const existingBinding = this.tenantBindings.get(cleanUserId);
    if (existingBinding && existingBinding.nodeId !== nodeId) {
      const existingAcc = this.accounts.get(existingBinding.nodeId);
      if (
        walletAddress &&
        existingAcc?.walletAddress &&
        existingAcc.walletAddress.toLowerCase() !== walletAddress.toLowerCase()
      ) {
        throw new Error(
          `Anti-IDOR Violation: Tenant '${cleanUserId}' is already bound to another wallet`
        );
      }
    }

    const hwProfile = this.classifyHardwareForFoxyFinance(specs);
    account.linkedTenantUserId = cleanUserId;
    account.hardwareClass = hwProfile.hardwareClass;

    const bindingRecord = {
      tenantUserId: cleanUserId,
      nodeId,
      walletAddress: account.walletAddress,
      hardwareClass: hwProfile.hardwareClass,
      discountPercent: hwProfile.discountPercent,
      freeProQuant: hwProfile.freeProQuant,
      hardwareLabel: hwProfile.label,
      linkedAt: new Date().toISOString()
    };

    this.tenantBindings.set(cleanUserId, bindingRecord);
    return bindingRecord;
  }

  getTenantBinding(tenantUserId) {
    if (!tenantUserId) return null;
    return this.tenantBindings.get(String(tenantUserId).trim()) || null;
  }

  async burnTokensForService(nodeId, amountFoxy, reason = 'FOXY_FINANCE_SUBSCRIPTION') {
    const account = this.getAccount(nodeId);
    const burnAmount = parseFloat(Number(amountFoxy).toFixed(4));
    if (isNaN(burnAmount) || burnAmount <= 0) {
      return { success: false, error: 'Burn amount must be greater than 0' };
    }
    if (account.balance < burnAmount) {
      return {
        success: false,
        error: `Insufficient $FOXY balance: required ${burnAmount}, available ${account.balance}`
      };
    }

    account.balance = parseFloat((account.balance - burnAmount).toFixed(4));
    account.burnedTokens = parseFloat(((account.burnedTokens || 0) + burnAmount).toFixed(4));
    this.networkTotalBurned = parseFloat((this.networkTotalBurned + burnAmount).toFixed(4));

    const burnHash = ethers.solidityPackedKeccak256(
      ['string', 'address', 'uint256', 'string', 'uint256'],
      [nodeId, account.walletAddress, ethers.parseEther(burnAmount.toFixed(4)), reason, this.currentEpoch]
    );
    const signature = await this.oracleWallet.signMessage(ethers.getBytes(burnHash));

    return {
      success: true,
      nodeId,
      walletAddress: account.walletAddress,
      burnedAmount: burnAmount,
      remainingBalance: account.balance,
      networkTotalBurned: this.networkTotalBurned,
      reason,
      epoch: this.currentEpoch,
      burnTxHash: '0x' + crypto.randomBytes(32).toString('hex'),
      oracleSignature: signature,
      timestamp: new Date().toISOString()
    };
  }

  recordProtocolBuybackBurn(usdAmount, tokenFloorPriceUsd = 0.12) {
    const safePrice = Math.max(0.01, Number(tokenFloorPriceUsd || 0.12));
    const burnedFoxy = parseFloat((Number(usdAmount || 0) / safePrice).toFixed(4));
    if (burnedFoxy > 0) {
      this.networkTotalBurned = parseFloat((this.networkTotalBurned + burnedFoxy).toFixed(4));
    }
    return burnedFoxy;
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
