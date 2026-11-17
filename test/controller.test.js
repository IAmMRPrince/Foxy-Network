import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createController } from '../packages/foxy-controller/src/index.js';
import { FoxyNetworkClient, FoxyNetworkError } from '../packages/foxy-finance-workload/src/network-client.js';
import { runDeterministicJob } from '../packages/foxy-jobs/src/index.js';

const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';

async function setup(t) {
  const controller = createController({
    port: 0, host: '127.0.0.1', persist: false, autoSettle: false,
    networkSecret: 'net-secret', adminKey: 'admin-key', partnerSecret: 'partner-secret',
    oracleWallet: ethers.Wallet.createRandom()
  });
  const port = await controller.listen();
  t.after(() => controller.close());
  const base = `http://127.0.0.1:${port}`;

  const post = async (route, body, headers = {}) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const get = async (route) => {
    const res = await fetch(base + route);
    return { status: res.status, data: await res.json() };
  };

  /** Registers a node and returns helpers that act as that node. */
  const addNode = async (nodeId, extra = {}) => {
    const reg = await post('/api/nodes/register', { nodeId, specs: { cores: 4, totalRamMb: 8192 }, walletAddress: WALLET_A, ...extra });
    assert.equal(reg.status, 200);
    const auth = { Authorization: `Bearer ${reg.data.nodeToken}` };
    return {
      nodeId, auth, reg: reg.data,
      call: (route, body = {}) => post(route, { nodeId, ...body }, auth),
      heartbeat: (body = {}) => post('/api/nodes/heartbeat', { nodeId, ...body }, auth)
    };
  };

  const finance = new FoxyNetworkClient({ baseUrl: base, secret: 'partner-secret' });
  return { controller, base, post, get, addNode, finance };
}

/** Plays the node's part: fetch commands, run the jobs, report results. */
async function workJobs(node, { corrupt = false } = {}) {
  const hb = await node.heartbeat();
  const jobs = hb.data.pendingCommands.filter(c => c.type === 'RUN_JOB');
  for (const cmd of jobs) {
    const result = runDeterministicJob(cmd.jobType, cmd.params);
    if (corrupt) result.tampered = true;
    const res = await node.call('/api/nodes/jobs/result', { jobId: cmd.jobId, result, durationMs: 5 });
    assert.equal(res.status, 200);
  }
  return jobs.length;
}

test('a node id cannot be taken over, and node endpoints need its token', async (t) => {
  const { post, get, addNode } = await setup(t);
  const node = await addNode('node-alpha');

  // Re-registering the same id without its token is refused
  assert.equal((await post('/api/nodes/register', { nodeId: 'node-alpha' })).status, 401);
  const other = await addNode('node-beta');
  assert.equal((await post('/api/nodes/register', { nodeId: 'node-alpha' }, other.auth)).status, 401);
  assert.equal((await post('/api/nodes/register', { nodeId: 'node-alpha' }, node.auth)).status, 200);
  assert.equal((await post('/api/nodes/register', { nodeId: '<script>' })).status, 400);

  // Heartbeat / claim / link-code with no token, or with another node's token
  for (const route of ['/api/nodes/heartbeat', '/api/ledger/claim', '/api/nodes/link-code', '/api/auth/token', '/api/nodes/jobs/result', '/api/nodes/pay-with-foxy']) {
    assert.equal((await post(route, { nodeId: 'node-alpha', subdomain: 'x' })).status, 401, route);
    assert.equal((await post(route, { nodeId: 'node-alpha', subdomain: 'x' }, other.auth)).status, 401, route);
  }

  // The public node list never leaks tokens
  const list = await get('/api/nodes');
  assert.equal(list.data.count, 2);
  assert.ok(!JSON.stringify(list.data).includes('eyJ'), 'no JWT in public output');
});

test('rewards can only be claimed by the node itself, to a valid address', async (t) => {
  const { controller, addNode } = await setup(t);
  const node = await addNode('node-alpha');
  const thief = await addNode('node-thief');

  await node.heartbeat({ walletAddress: WALLET_A });
  controller.ledger.settleEpoch();
  const balance = controller.ledger.accounts.get('node-alpha').balance;
  assert.ok(balance > 0);

  // Another node cannot claim node-alpha's balance for itself
  const stolen = await thief.call('/api/ledger/claim', { nodeId: 'node-alpha', walletAddress: WALLET_B });
  assert.equal(stolen.status, 401);
  assert.equal(controller.ledger.accounts.get('node-alpha').balance, balance);

  assert.equal((await node.call('/api/ledger/claim', { walletAddress: 'not-an-address' })).status, 400);

  const claim = await node.call('/api/ledger/claim', {});
  assert.equal(claim.status, 200);
  assert.equal(claim.data.receipt.to, WALLET_A);
  assert.equal(claim.data.receipt.settlement, 'SIMULATED'); // no contract configured
  assert.equal(claim.data.receipt.txHash, undefined, 'no fabricated transaction hash');
  assert.equal(controller.ledger.accounts.get('node-alpha').balance, 0);
  assert.equal((await node.call('/api/ledger/claim', {})).status, 400); // nothing left
});

test('reported traffic is capped and uptime comes from the controller clock', async (t) => {
  const { controller, addNode } = await setup(t);
  const node = await addNode('node-alpha');
  await node.heartbeat({ telemetry: { bytesServed: 1e15, vpnBytesServed: 1e15 } });
  const acc = controller.ledger.accounts.get('node-alpha');
  assert.ok(acc.pendingUptimeSeconds <= 10);
  assert.ok(acc.pendingBytesServed <= 10 * 12.5 * 1024 * 1024);
  assert.ok(acc.pendingVpnBytes <= 10 * 12.5 * 1024 * 1024);
});

test('subdomains belong to the first node that takes them', async (t) => {
  const { addNode } = await setup(t);
  const a = await addNode('node-alpha', { subdomain: 'shop' });
  const b = await addNode('node-beta', { subdomain: 'shop' });
  assert.equal(a.reg.subdomain, 'shop');
  assert.notEqual(b.reg.subdomain, 'shop'); // got its own name instead

  assert.equal((await a.call('/api/auth/token', { subdomain: 'shop' })).status, 200);
  assert.equal((await b.call('/api/auth/token', { subdomain: 'shop' })).status, 409);
  assert.equal((await b.call('/api/auth/token', { subdomain: 'beta-app' })).status, 200);
  assert.equal((await a.call('/api/auth/token', { subdomain: 'beta-app' })).status, 409);
});

test('operator endpoints need the admin key; deployments are sent once', async (t) => {
  const { post, get, addNode } = await setup(t);
  const node = await addNode('node-alpha');
  const admin = { 'X-Foxy-Admin-Key': 'admin-key' };

  assert.equal((await post('/api/deployments', { subdomain: 'tienda' })).status, 401);
  assert.equal((await post('/api/deployments', { subdomain: 'tienda' }, { 'X-Foxy-Admin-Key': 'nope' })).status, 401);
  assert.equal((await post('/api/premium/subscribe', { planId: 'PRO_DEVELOPER' })).status, 401);

  const dep = await post('/api/deployments', { subdomain: 'tienda', appName: '<img src=x onerror=alert(1)>' }, admin);
  assert.equal(dep.status, 201);
  assert.ok(!dep.data.deployment.appName.includes('<'));
  assert.equal(dep.data.deployment.authToken, undefined);
  assert.equal((await post('/api/deployments', { subdomain: 'tienda' }, admin)).status, 409);

  const first = await node.heartbeat();
  assert.equal(first.data.pendingCommands.filter(c => c.type === 'DEPLOY_WORKLOAD').length, 1);
  const second = await node.heartbeat();
  assert.equal(second.data.pendingCommands.length, 0, 'not re-sent on every heartbeat');
  const third = await node.heartbeat({ activeWorkloads: [{ id: dep.data.deployment.id, status: 'RUNNING' }] });
  assert.equal(third.data.pendingCommands.length, 0);
  const listed = await get('/api/deployments');
  assert.equal(listed.data.deployments[0].status, 'RUNNING');
  assert.ok(!JSON.stringify(listed.data).includes('eyJ'));

});

test('the controller dashboard never renders node-supplied markup', async (t) => {
  const { base, addNode } = await setup(t);
  await addNode('node-xss', { name: '"><script>alert(1)</script>' });
  const html = await (await fetch(base + '/')).text();
  assert.ok(!html.includes('<script>alert(1)'));
});

test('partner API rejects unsigned, mis-signed and replayed requests', async (t) => {
  const { base, post, finance } = await setup(t);
  assert.equal((await post('/api/partner/v1/jobs', { type: 'sha256_benchmark' })).status, 401);
  assert.equal((await post('/api/foxy-finance/dispatch', { type: 'sha256_benchmark' })).status, 401);
  assert.equal((await fetch(base + '/api/partner/v1/users/u1/benefits')).status, 401);

  const wrong = new FoxyNetworkClient({ baseUrl: base, secret: 'not-the-secret' });
  await assert.rejects(wrong.getNetwork(), (e) => e instanceof FoxyNetworkError && e.status === 401);

  // A signature made for one body does not authorize another
  const body = JSON.stringify({ type: 'sha256_benchmark' });
  const headers = finance.sign('POST', '/api/partner/v1/jobs', body);
  const tampered = await fetch(base + '/api/partner/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ type: 'matrix_benchmark' }) });
  assert.equal(tampered.status, 401);
  // ...and an old signature is refused
  const old = finance.sign('POST', '/api/partner/v1/jobs', body, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await fetch(base + '/api/partner/v1/jobs', { method: 'POST', headers: old, body })).status, 401);

  const network = await finance.getNetwork();
  assert.deepEqual(network.jobTypes.sort(), ['latency_probe', 'matrix_benchmark', 'monte_carlo_gbm', 'sha256_benchmark']);
  assert.equal(network.benefitMatrix.SERVER.discountPercent, 100);
});

test('linking: only a code from the node itself binds it to a Foxy Finance user', async (t) => {
  const { controller, addNode, finance } = await setup(t);
  const node = await addNode('node-alpha', { deviceClass: 'PC' });

  // Guessing codes does not work, and is rate limited per user
  for (let i = 0; i < 5; i++) {
    await assert.rejects(finance.redeemLinkCode('AAAAA-BBBBB', 'mallory'), (e) => e.status === 404);
  }
  await assert.rejects(finance.redeemLinkCode('AAAAA-BBBBB', 'mallory'), (e) => e.status === 429);

  const { data: code } = await node.call('/api/nodes/link-code');
  assert.match(code.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  await assert.rejects(finance.redeemLinkCode(code.code, 'bad user id!'), (e) => e.status === 400);

  const linked = await finance.redeemLinkCode(code.code.toLowerCase(), 'user-42');
  assert.equal(linked.nodeId, 'node-alpha');
  // One use only
  await assert.rejects(finance.redeemLinkCode(code.code, 'user-99'), (e) => e.status === 404);

  // A new code invalidates the previous one
  const c1 = (await node.call('/api/nodes/link-code')).data.code;
  const c2 = (await node.call('/api/nodes/link-code')).data.code;
  await assert.rejects(finance.redeemLinkCode(c1, 'user-42'), (e) => e.status === 404);
  await finance.redeemLinkCode(c2, 'user-42');

  // Benefits: the node is online and was online since it was first seen
  await node.heartbeat();
  controller.ledger.recordActivity('node-alpha', { uptimeDeltaSeconds: 3600 });
  const benefits = await finance.getUserBenefits('user-42');
  assert.equal(benefits.linkedNodes, 1);
  assert.equal(benefits.discountPercent, 70);
  assert.equal(benefits.grantingNodeId, 'node-alpha');

  // Another user gets nothing from this node, and cannot revoke it
  assert.equal((await finance.getUserBenefits('user-99')).discountPercent, 0);
  await assert.rejects(finance.revokeLink('node-alpha', 'user-99'), (e) => e.status === 404);

  // Node goes silent -> benefit is withdrawn
  controller.nodes.get('node-alpha').lastHeartbeat = Date.now() - 3600 * 1000;
  const offline = await finance.getUserBenefits('user-42');
  assert.equal(offline.discountPercent, 0);
  assert.equal(offline.nodes[0].ineligibleReason, 'NODE_OFFLINE');

  // The donor can unlink from their side
  assert.equal((await node.call('/api/nodes/unlink')).data.unlinked, true);
  assert.equal((await finance.getUserBenefits('user-42')).linkedNodes, 0);
});

test('device class: a small machine cannot declare itself a server', async (t) => {
  const { controller, addNode, finance } = await setup(t);
  const small = await addNode('node-small', { deviceClass: 'SERVER', specs: { cores: 2, totalRamMb: 2048 } });
  const big = await addNode('node-big', { deviceClass: 'SERVER', specs: { cores: 16, totalRamMb: 65536 } });
  const pi = await addNode('node-pi', { deviceClass: 'SBC', specs: { cores: 4, totalRamMb: 4096 } });
  for (const [node, user] of [[small, 'u-small'], [big, 'u-big'], [pi, 'u-pi']]) {
    await finance.redeemLinkCode((await node.call('/api/nodes/link-code')).data.code, user);
    controller.ledger.recordActivity(node.nodeId, { uptimeDeltaSeconds: 3600 });
  }
  assert.equal((await finance.getUserBenefits('u-small')).discountPercent, 70);
  const server = await finance.getUserBenefits('u-big');
  assert.equal(server.discountPercent, 100);
  assert.equal(server.grantedPlan, 'PRO_QUANT');
  assert.equal((await finance.getUserBenefits('u-pi')).discountPercent, 50);
});

test('jobs: nodes run them, results are cross-checked, only honest nodes are paid', async (t) => {
  const { controller, addNode, finance } = await setup(t);
  const a = await addNode('node-a');
  const b = await addNode('node-b');
  const c = await addNode('node-c');

  await assert.rejects(finance.submitJob('evil_type', {}), (e) => e.status === 400);
  await assert.rejects(finance.submitJob('sha256_benchmark', { iterations: 1e15 }), (e) => e.status === 400);
  await assert.rejects(finance.submitJob('latency_probe', { targets: [{ host: 'api.example.com' }] }, { replicas: 2 }), (e) => e.status === 400);

  // Single node
  const single = await finance.submitJob('sha256_benchmark', { iterations: 2000, seed: 5 });
  assert.equal(single.status, 'QUEUED');
  assert.equal(await workJobs(a), 1);
  assert.equal(await workJobs(a), 0, 'a node never gets the same job twice');
  const doneSingle = await finance.getJob(single.id);
  assert.equal(doneSingle.status, 'COMPLETED');
  assert.deepEqual(doneSingle.result, runDeterministicJob('sha256_benchmark', { iterations: 2000, seed: 5 }));
  assert.equal(doneSingle.verification.mode, 'SINGLE_NODE');
  assert.equal(controller.ledger.accounts.get('node-a').pendingComputeUnits, doneSingle.computeUnits);

  // Idempotency: the same key returns the same job
  const i1 = await finance.submitJob('matrix_benchmark', { size: 16 }, { idempotencyKey: 'k-1', replicas: 3 });
  const i2 = await finance.submitJob('matrix_benchmark', { size: 16 }, { idempotencyKey: 'k-1', replicas: 3 });
  assert.equal(i1.id, i2.id);

  // Three replicas, one node lies: the majority result stands and the liar is not paid
  const before = (id) => controller.ledger.accounts.get(id).lifetimeComputeUnits;
  const [ua, ub, uc] = [before('node-a'), before('node-b'), before('node-c')];
  await workJobs(a);
  await workJobs(b, { corrupt: true });
  assert.equal((await finance.getJob(i1.id)).status, 'QUEUED', 'two results that disagree are not enough: waits for the third');
  await workJobs(c);
  const replicated = await finance.getJob(i1.id);
  assert.equal(replicated.status, 'COMPLETED');
  assert.equal(replicated.verification.mode, 'REPLICATED');
  assert.equal(replicated.verification.agreeing, 2);
  assert.deepEqual(replicated.verification.dissentingNodes, ['node-b']);
  assert.equal(replicated.result.tampered, undefined);
  assert.equal(before('node-a') - ua, replicated.computeUnits);
  assert.equal(before('node-b') - ub, 0);
  assert.equal(before('node-c') - uc, replicated.computeUnits);

  // Two replicas that disagree: the job fails and nobody is paid
  const pair = await finance.submitJob('matrix_benchmark', { size: 12 }, { replicas: 2 });
  const [pa, pb] = [before('node-a'), before('node-b')];
  await workJobs(a);
  await workJobs(b, { corrupt: true });
  const failed = await finance.getJob(pair.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.result, null);
  assert.equal(before('node-a') - pa, 0);
  assert.equal(before('node-b') - pb, 0);

  // A node cannot report a job that was not given to it
  const stray = await finance.submitJob('sha256_benchmark', { iterations: 2000 });
  const res = await c.call('/api/nodes/jobs/result', { jobId: stray.id, result: { digest: 'x' } });
  assert.equal(res.status, 404);

  // Compute units become $FOXY at settlement
  controller.ledger.settleEpoch();
  assert.ok(controller.ledger.accounts.get('node-a').balance >= 3.5);
});

test('paying a plan with $FOXY burns the balance of a linked node', async (t) => {
  const { controller, addNode, finance } = await setup(t);
  const node = await addNode('node-alpha');

  // Not linked yet
  assert.equal((await node.call('/api/nodes/pay-with-foxy', { planId: 'FOXY_FINANCE_TRADER_PRO' })).status, 409);
  await finance.redeemLinkCode((await node.call('/api/nodes/link-code')).data.code, 'user-42');

  // Not enough balance
  assert.equal((await node.call('/api/nodes/pay-with-foxy', { planId: 'FOXY_FINANCE_TRADER_PRO' })).status, 402);
  assert.equal((await node.call('/api/nodes/pay-with-foxy', { planId: 'NOPE' })).status, 400);
  assert.equal((await node.call('/api/nodes/pay-with-foxy', { planId: 'COMMUNITY_FREE' })).status, 400);

  controller.ledger.recordCompute('node-alpha', 100); // 350 $FOXY
  controller.ledger.settleEpoch();
  const paid = await node.call('/api/nodes/pay-with-foxy', { planId: 'FOXY_FINANCE_TRADER_PRO' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.payment.amountFoxy, 325);
  assert.equal(paid.data.balance, 25);
  assert.equal(controller.ledger.networkTotalBurned, 325);

  const payments = await finance.getUserPayments('user-42');
  assert.equal(payments.payments.length, 1);
  assert.equal(payments.payments[0].planId, 'FOXY_FINANCE_TRADER_PRO');
  assert.equal((await finance.getUserPayments('user-99')).payments.length, 0);

  // The balance cannot be spent twice
  assert.equal((await node.call('/api/nodes/pay-with-foxy', { planId: 'FOXY_FINANCE_TRADER_PRO' })).status, 402);
});

test('oversized and malformed bodies are refused', async (t) => {
  const { base } = await setup(t);
  const big = await fetch(base + '/api/nodes/register', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) }).then(r => r.status).catch(() => 'reset');
  assert.ok(big === 413 || big === 'reset');
  assert.equal((await fetch(base + '/api/nodes/register', { method: 'POST', body: '{not json' })).status, 400);
  assert.equal((await fetch(base + '/api/nodes/register', { method: 'POST', body: '[1,2]' })).status, 400);
});
