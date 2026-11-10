// End-to-end contract tests on an in-memory EVM.
// Needs the optional `ganache` package (npm install --no-save ganache); skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { deployFoxyContracts } from '../deploy.js';
import { FoxyLedger } from '../../foxy-controller/src/ledger.js';

let ganache = null;
try {
  ganache = (await import('ganache')).default;
} catch {
  // optional dependency not installed
}

const E = (n) => ethers.parseEther(String(n));
const id = (s) => ethers.encodeBytes32String(s);

test('contracts on a local EVM', { skip: !ganache && 'ganache not installed' }, async (t) => {
  const raw = ganache.provider({ logging: { quiet: true }, chain: { chainId: 31337 }, wallet: { totalAccounts: 5 } });
  // cacheTimeout -1: ethers must not reuse a result from before a state change
  const provider = new ethers.BrowserProvider(raw, undefined, { cacheTimeout: -1 });
  const [deployer, founder, donor, customer, stranger] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));
  const oracle = ethers.Wallet.createRandom();
  const chainId = Number((await provider.getNetwork()).chainId);

  const { token, vault } = await deployFoxyContracts(deployer, { oracleAddress: oracle.address, founderWallet: founder.address });
  const tokenAddress = await token.getAddress();
  const vaultAddress = await vault.getAddress();

  await t.test('the ledger voucher mints on-chain exactly once', async () => {
    const ledger = new FoxyLedger({ oracleWallet: oracle, autoSettle: false });
    ledger.recordActivity('node-a', { uptimeDeltaSeconds: 600, walletAddress: donor.address });
    ledger.settleEpoch();
    const expected = ledger.accounts.get('node-a').balance;
    assert.ok(expected > 0);

    const claim = await ledger.claimRewards('node-a', null, { chainId, contractAddress: tokenAddress });
    assert.equal(claim.receipt.settlement, 'ONCHAIN_VOUCHER');
    const r = claim.receipt;

    // Someone else cannot redeem the donor's voucher
    await assert.rejects(token.connect(stranger).claimContributionReward(r.amountWei, r.epoch, r.signature));

    await (await token.connect(donor).claimContributionReward(r.amountWei, r.epoch, r.signature)).wait();
    assert.equal(await token.balanceOf(donor.address), E(expected));

    // Replay is rejected (nonce moved on)
    await assert.rejects(token.connect(donor).claimContributionReward(r.amountWei, r.epoch, r.signature));

    // A second voucher uses the next nonce and also works
    ledger.recordActivity('node-a', { uptimeDeltaSeconds: 600 });
    ledger.settleEpoch();
    const second = await ledger.claimRewards('node-a', null, { chainId, contractAddress: tokenAddress });
    assert.equal(second.receipt.nonce, 1);
    await (await token.connect(donor).claimContributionReward(second.receipt.amountWei, second.receipt.epoch, second.receipt.signature)).wait();
  });

  await t.test('a voucher signed by anyone but the oracle is rejected', async () => {
    const fake = new FoxyLedger({ oracleWallet: ethers.Wallet.createRandom(), autoSettle: false });
    fake.recordActivity('node-x', { uptimeDeltaSeconds: 600, walletAddress: stranger.address });
    fake.settleEpoch();
    const claim = await fake.claimRewards('node-x', null, { chainId, contractAddress: tokenAddress });
    await assert.rejects(token.connect(stranger).claimContributionReward(claim.receipt.amountWei, claim.receipt.epoch, claim.receipt.signature));
  });

  await t.test('native payment: split, refund, subscription and reserve withdrawal', async () => {
    const plan = await vault.plans(id('PRO_TUNNEL'));
    const founderBefore = await provider.getBalance(founder.address);

    await assert.rejects(vault.connect(customer).purchasePremium(id('PRO_TUNNEL'), { value: plan.price - 1n }));
    await (await vault.connect(customer).purchasePremium(id('PRO_TUNNEL'), { value: plan.price + E(1) })).wait();

    assert.equal(await provider.getBalance(founder.address) - founderBefore, plan.price * 40n / 100n);
    assert.equal(await vault.donorReserveBalance(), plan.price * 45n / 100n);
    assert.equal(await vault.buybackBalance(), plan.price * 15n / 100n);
    // The extra 1 ETH was refunded: the vault holds only the 60% it accounts for
    assert.equal(await provider.getBalance(vaultAddress), plan.price * 60n / 100n);
    assert.equal(await vault.isSubscribed(customer.address, id('PRO_TUNNEL')), true);
    assert.equal(await vault.isSubscribed(stranger.address, id('PRO_TUNNEL')), false);

    await assert.rejects(vault.connect(stranger).disburseDonorReserve(stranger.address, 1n, 0n));
    await assert.rejects(vault.connect(deployer).disburseDonorReserve(donor.address, plan.price, 0n)); // more than the reserve

    const donorBefore = await provider.getBalance(donor.address);
    await (await vault.connect(deployer).disburseDonorReserve(donor.address, plan.price * 45n / 100n, 0n)).wait();
    assert.equal(await provider.getBalance(donor.address) - donorBefore, plan.price * 45n / 100n);

    await (await vault.connect(deployer).withdrawBuyback(deployer.address, plan.price * 15n / 100n)).wait();
    assert.equal(await provider.getBalance(vaultAddress), 0n); // nothing is left stranded
  });

  await t.test('payment in $FOXY burns 15%, pays the founder 40% and keeps 45%', async () => {
    const price = (await vault.plans(id('FOXY_FINANCE_TRADER_PRO'))).priceFoxy;
    assert.equal(price, E(325));
    await (await token.connect(deployer).transfer(customer.address, price)).wait();

    const supplyBefore = await token.totalSupply();
    const founderBefore = await token.balanceOf(founder.address);

    await assert.rejects(vault.connect(customer).paySubscriptionWithFoxy(id('FOXY_FINANCE_TRADER_PRO'), price)); // no allowance
    await (await token.connect(customer).approve(vaultAddress, price)).wait();
    await assert.rejects(vault.connect(customer).paySubscriptionWithFoxy(id('FOXY_FINANCE_TRADER_PRO'), price - 1n)); // underpaying
    await (await vault.connect(customer).paySubscriptionWithFoxy(id('FOXY_FINANCE_TRADER_PRO'), price)).wait();

    assert.equal(supplyBefore - await token.totalSupply(), price * 15n / 100n);
    assert.equal(await token.balanceOf(founder.address) - founderBefore, price * 40n / 100n);
    assert.equal(await token.balanceOf(vaultAddress), price * 45n / 100n);
    assert.equal(await vault.foxyDonorReserve(), price * 45n / 100n);
    assert.equal(await token.balanceOf(customer.address), 0n);
    assert.equal(await vault.isSubscribed(customer.address, id('FOXY_FINANCE_TRADER_PRO')), true);

    await (await vault.connect(deployer).disburseDonorReserve(donor.address, 0n, price * 45n / 100n)).wait();
    assert.equal(await token.balanceOf(vaultAddress), 0n);
  });

  await t.test('only the owner administers the vault', async () => {
    await assert.rejects(vault.connect(stranger).setFounderWallet(stranger.address));
    await assert.rejects(vault.connect(stranger).setFeeSplits(10000, 0, 0));
    await assert.rejects(vault.connect(stranger).bindFoxyFinanceTenant(ethers.id('user-1'), stranger.address));
    await (await vault.connect(deployer).bindFoxyFinanceTenant(ethers.id('user-1'), donor.address)).wait();
    assert.equal(await vault.tenantNodeBinding(ethers.id('user-1')), donor.address);
  });

  await raw.disconnect();
});
