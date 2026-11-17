// ==============================================================================
// Foxy Network - Premium Services & Dynamic Resource Valuation Engine
// Monetization, Founder Margins, and Foxy Finance Institutional Demand
// ==============================================================================

import { randomUUID } from 'node:crypto';

export const PREMIUM_PLANS = {
  COMMUNITY_FREE: {
    id: 'COMMUNITY_FREE',
    name: 'Plan Comunitario Gratuito',
    priceUsd: 0,
    priceFoxy: 0,
    features: [
      'Subdominio dinámico .localhost / foxy-cluster',
      'Túneles inversos compartidos',
      'Ancho de banda estándar',
      'Acceso comunitario a la dVPN'
    ]
  },
  PRO_DEVELOPER: {
    id: 'PRO_DEVELOPER',
    name: 'Foxy Pro Developer & Business Tunnel',
    priceUsd: 19.00,
    priceFoxy: 150.00, // 20% discount if paid with $FOXY
    billingCycle: 'monthly',
    features: [
      'Túneles dedicados con conmutación por error en <1s',
      'Dominio raíz personalizado con certificados TLS/SSL automáticos',
      'Nodos donantes de rendimiento ULTRA_COMPUTE',
      'Soporte prioritario y SLA de 99.9%'
    ]
  },
  ENTERPRISE_DVPN: {
    id: 'ENTERPRISE_DVPN',
    name: 'Foxy Enterprise dVPN Business Pool',
    priceUsd: 49.00,
    priceFoxy: 390.00,
    billingCycle: 'monthly',
    features: [
      'Acceso a pools de salida residencial exclusiva',
      'Cifrado multicapa ChaCha20 / AES-256-GCM',
      'Ancho de banda ilimitado de alta velocidad',
      'Asignación de IPs estáticas de salida'
    ]
  },
  FOXY_FINANCE_TRADER_PRO: {
    id: 'FOXY_FINANCE_TRADER_PRO',
    name: 'Foxy Finance Trader Pro',
    priceUsd: 49.00,
    priceFoxy: 325.00, // ~20% discount if paid with $FOXY
    billingCycle: 'monthly',
    features: ['Plan Trader Pro de Foxy Finance']
  },
  FOXY_FINANCE_INSTITUTIONAL_DESK: {
    id: 'FOXY_FINANCE_INSTITUTIONAL_DESK',
    name: 'Foxy Finance Institutional Desk',
    priceUsd: 199.00,
    priceFoxy: 1320.00,
    billingCycle: 'monthly',
    features: ['Plan Institutional Desk de Foxy Finance']
  },
  FOXY_FINANCE_INSTITUTIONAL: {
    id: 'FOXY_FINANCE_INSTITUTIONAL',
    name: 'Foxy Finance Sovereign Cloud Cluster',
    priceUsd: 299.00,
    priceFoxy: 2400.00,
    billingCycle: 'monthly',
    features: [
      'Ejecución prioritaria de microservicios financieros y bots de arbitraje',
      'Verificación criptográfica de estado (ZK/PoC attestations)',
      'Pool de nodos de baja latencia garantizados (<20ms)',
      'Contratos de cómputo respaldados on-chain'
    ]
  }
};

// Protocol Revenue Split: 40% Founder Margin | 45% Donor Backing Reserve | 15% Deflationary Burn
export const REVENUE_DISTRIBUTION = {
  FOUNDER_MARGIN_PERCENT: 40.0,
  DONOR_BACKING_RESERVE_PERCENT: 45.0,
  DEFLATIONARY_BURN_PERCENT: 15.0
};

// Internal accounting units
export const CREDIT_RATES_USD = {
  FCC: 0.20, // Foxy Compute Credit: one compute unit of a partner job
  FXC: 0.01  // Foxy Credit: bandwidth / dVPN unit
};

// Industry benchmark rates (based on AWS EC2 / DigitalOcean pricing in USD)
export const CLOUD_BENCHMARK_RATES_USD = {
  CPU_CORE_HOUR: 0.025,       // $0.025 per CPU core-hour
  RAM_GB_HOUR: 0.005,         // $0.005 per GB RAM-hour
  BANDWIDTH_WEB_GB: 0.08,     // $0.08 per GB web bandwidth
  DVPN_TRAFFIC_GB: 0.15       // $0.15 per GB encrypted residential VPN egress
};

export class PremiumEngine {
  /**
   * NOTE: this engine is an ACCOUNTING SIMULATION. It models how revenue would
   * be split; it does not hold funds, move money or set a market price.
   */
  constructor() {
    this.activeSubscriptions = new Map(); // subId -> subscription
    this.treasury = {
      simulated: true,
      totalRevenueUsd: 0,
      founderProfitUsd: 0,
      donorBackingPoolUsd: 0,
      totalBurnedUsd: 0,
      // Reference value only: reserve / tokens credited. Not a price, not a guarantee.
      foxyTokenFloorPriceUsd: 0,
      totalFccConsumed: 0
    };
    this.creditedSupply = 0;
    this.foxyFinanceWorkloads = [];
  }

  /**
   * Calculates the exact fair market value in USD of resources donated by a node
   */
  calculateResourceUsdValue({ uptimeSeconds, bytesServed, vpnBytesServed, specs }) {
    const hours = uptimeSeconds / 3600;
    const cores = specs?.cores || 2;
    const ramGb = (specs?.totalRamMb || 2048) / 1024;
    const webGb = bytesServed / (1024 * 1024 * 1024);
    const vpnGb = vpnBytesServed / (1024 * 1024 * 1024);

    const computeVal = (cores * CLOUD_BENCHMARK_RATES_USD.CPU_CORE_HOUR * hours) +
                       (ramGb * CLOUD_BENCHMARK_RATES_USD.RAM_GB_HOUR * hours);
    const bandwidthVal = webGb * CLOUD_BENCHMARK_RATES_USD.BANDWIDTH_WEB_GB;
    const vpnVal = vpnGb * CLOUD_BENCHMARK_RATES_USD.DVPN_TRAFFIC_GB;

    const totalUsd = computeVal + bandwidthVal + vpnVal;
    return {
      totalUsd: parseFloat(totalUsd.toFixed(4)),
      breakdown: {
        computeVal: parseFloat(computeVal.toFixed(4)),
        bandwidthVal: parseFloat(bandwidthVal.toFixed(4)),
        vpnVal: parseFloat(vpnVal.toFixed(4))
      }
    };
  }

  /**
   * Processes a premium service purchase (in USD or $FOXY)
   */
  subscribePlan(planId, subscriberAddress, paymentMethod = 'USD') {
    const plan = Object.hasOwn(PREMIUM_PLANS, planId) ? PREMIUM_PLANS[planId] : null;
    if (!plan) throw new Error(`Plan no reconocido: ${planId}`);

    const subId = `sub-${randomUUID().slice(0, 8)}`;
    const revenueUsd = plan.priceUsd;

    // Distribute Revenue
    const founderProfit = (revenueUsd * REVENUE_DISTRIBUTION.FOUNDER_MARGIN_PERCENT) / 100;
    const donorReserve = (revenueUsd * REVENUE_DISTRIBUTION.DONOR_BACKING_RESERVE_PERCENT) / 100;
    const burnShare = (revenueUsd * REVENUE_DISTRIBUTION.DEFLATIONARY_BURN_PERCENT) / 100;

    this.treasury.totalRevenueUsd += revenueUsd;
    this.treasury.founderProfitUsd += founderProfit;
    this.treasury.donorBackingPoolUsd += donorReserve;
    this.treasury.totalBurnedUsd += burnShare;

    // Recalculate token floor price based on increased treasury backing
    this.updateTokenValuation();

    const subRecord = {
      subId,
      planId,
      planName: plan.name,
      subscriber: subscriberAddress,
      paymentMethod,
      amountPaid: paymentMethod === 'FOXY' ? plan.priceFoxy : plan.priceUsd,
      revenueDistribution: {
        founderProfitUsd: parseFloat(founderProfit.toFixed(2)),
        donorReserveUsd: parseFloat(donorReserve.toFixed(2)),
        burnedUsd: parseFloat(burnShare.toFixed(2))
      },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE'
    };

    this.activeSubscriptions.set(subId, subRecord);
    return subRecord;
  }

  /**
   * Ingests computational workloads from Foxy Finance
   */
  recordFoxyFinanceCompute({ workloadName, computeUnits, billingUsd, timestamp, jobId = null }) {
    const revenueUsd = Number.isFinite(billingUsd) && billingUsd !== null ? billingUsd : (computeUnits * CREDIT_RATES_USD.FCC);

    const founderProfit = (revenueUsd * REVENUE_DISTRIBUTION.FOUNDER_MARGIN_PERCENT) / 100;
    const donorReserve = (revenueUsd * REVENUE_DISTRIBUTION.DONOR_BACKING_RESERVE_PERCENT) / 100;
    const burnShare = (revenueUsd * REVENUE_DISTRIBUTION.DEFLATIONARY_BURN_PERCENT) / 100;

    this.treasury.totalRevenueUsd += revenueUsd;
    this.treasury.founderProfitUsd += founderProfit;
    this.treasury.donorBackingPoolUsd += donorReserve;
    this.treasury.totalBurnedUsd += burnShare;

    this.treasury.totalFccConsumed += computeUnits;
    this.updateTokenValuation();

    const record = {
      id: jobId || `ff-job-${randomUUID().slice(0, 8)}`,
      client: 'Foxy Finance',
      workloadName: workloadName || 'compute',
      computeUnits,
      revenueUsd: parseFloat(revenueUsd.toFixed(2)),
      founderShareUsd: parseFloat(founderProfit.toFixed(2)),
      donorReserveUsd: parseFloat(donorReserve.toFixed(2)),
      timestamp: timestamp || new Date().toISOString()
    };

    this.foxyFinanceWorkloads.unshift(record);
    if (this.foxyFinanceWorkloads.length > 20) this.foxyFinanceWorkloads.pop();

    return record;
  }

  /** @param {number} [creditedSupply] total $FOXY credited to donors so far */
  updateTokenValuation(creditedSupply = null) {
    if (creditedSupply !== null) this.creditedSupply = Math.max(0, Number(creditedSupply) || 0);
    this.treasury.foxyTokenFloorPriceUsd = this.creditedSupply > 0
      ? parseFloat((this.treasury.donorBackingPoolUsd / this.creditedSupply).toFixed(6))
      : 0;
  }

  getTreasuryOverview() {
    return {
      treasury: {
        totalRevenueUsd: parseFloat(this.treasury.totalRevenueUsd.toFixed(2)),
        founderProfitUsd: parseFloat(this.treasury.founderProfitUsd.toFixed(2)),
        donorBackingPoolUsd: parseFloat(this.treasury.donorBackingPoolUsd.toFixed(2)),
        totalBurnedUsd: parseFloat(this.treasury.totalBurnedUsd.toFixed(2)),
        foxyTokenFloorPriceUsd: this.treasury.foxyTokenFloorPriceUsd
      },
      distributionModel: REVENUE_DISTRIBUTION,
      benchmarkRates: CLOUD_BENCHMARK_RATES_USD,
      creditRates: CREDIT_RATES_USD,
      plans: PREMIUM_PLANS,
      foxyFinanceRecentCompute: this.foxyFinanceWorkloads.slice(0, 5)
    };
  }
}
