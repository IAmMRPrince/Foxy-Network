// ==============================================================================
// Foxy Network - Donor Web3 EVM Wallet Manager
// Auto-provisions and manages Ethereum-compatible wallets for $FOXY rewards
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';

export class WalletManager {
  constructor(storageDir = null) {
    this.storageDir = storageDir || path.resolve(process.cwd(), '.foxy');
    this.walletFile = path.join(this.storageDir, 'wallet.json');
    this.walletData = null;
    this.init();
  }

  init() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    if (fs.existsSync(this.walletFile)) {
      try {
        const raw = fs.readFileSync(this.walletFile, 'utf-8');
        this.walletData = JSON.parse(raw);
      } catch (err) {
        console.error('[WalletManager] Error reading existing wallet, generating new one:', err.message);
        this.createNewWallet();
      }
    } else {
      this.createNewWallet();
    }
  }

  createNewWallet() {
    const randomWallet = ethers.Wallet.createRandom();
    this.walletData = {
      address: randomWallet.address,
      privateKey: randomWallet.privateKey,
      mnemonic: randomWallet.mnemonic ? randomWallet.mnemonic.phrase : null,
      customPayoutAddress: null,
      createdAt: new Date().toISOString()
    };
    this.save();
    console.log(`[WalletManager] 🦊 Nueva billetera Web3 auto-generada para recompensas $FOXY: ${this.walletData.address}`);
  }

  save() {
    try {
      fs.writeFileSync(this.walletFile, JSON.stringify(this.walletData, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      console.error('[WalletManager] Failed to persist wallet file:', err.message);
    }
  }

  getActiveAddress() {
    return this.walletData.customPayoutAddress || this.walletData.address;
  }

  setCustomPayoutAddress(address) {
    if (!address) {
      this.walletData.customPayoutAddress = null;
      this.save();
      return { success: true, activeAddress: this.walletData.address };
    }

    if (!ethers.isAddress(address)) {
      throw new Error(`Dirección EVM inválida: ${address}`);
    }

    this.walletData.customPayoutAddress = ethers.getAddress(address);
    this.save();
    return { success: true, activeAddress: this.walletData.customPayoutAddress };
  }

  getPublicProfile() {
    return {
      generatedAddress: this.walletData.address,
      customPayoutAddress: this.walletData.customPayoutAddress,
      activePayoutAddress: this.getActiveAddress(),
      hasMnemonic: !!this.walletData.mnemonic
    };
  }

  exportCredentials() {
    return {
      address: this.walletData.address,
      privateKey: this.walletData.privateKey,
      mnemonic: this.walletData.mnemonic,
      activePayoutAddress: this.getActiveAddress()
    };
  }
}
