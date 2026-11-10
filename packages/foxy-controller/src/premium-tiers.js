// ==============================================================================
// Foxy Network - Premium Services & Dynamic Resource Valuation Engine
// Monetization, Founder Margins, and Foxy Finance Institutional Demand
// ==============================================================================

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
    name: 'Foxy Finance Trader Pro SaaS',
    priceUsd: 49.00,
    priceFoxy: 325.00, // 20% discount when paying with $FOXY
    billingCycle: 'monthly',
    features: [
      'Señales cuantitativas en tiempo real y microestructura OBI',
      'Backtesting con barras de dólar (López de Prado) y criterio de Kelly',
      'Simulaciones de riesgo Monte Carlo VaR/CVaR (50,000 caminos)',
      '20% de descuento pagando con token nativo $FOXY'
    ]
  },
  FOXY_FINANCE_INSTITUTIONAL_DESK: {
    id: 'FOXY_FINANCE_INSTITUTIONAL_DESK',
    name: 'Foxy Finance Institutional / Desk',
    priceUsd: 199.00,
    priceFoxy: 1320.00, // 20% discount when paying with $FOXY
    billingCycle: 'monthly',
    features: [
      'Conexión multi-broker (Binance, Alpaca, MetaTrader 5)',
      'Modelos LSTM/GRU personalizados y filtros de anomalías con Autoencoder',
      'Canal dVPN residencial de ultra baja latencia (<20ms)',
      'Prioridad de ejecución en el clúster DePIN Foxy Network'
    ]
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

// Industry benchmark rates (based on AWS EC2 / DigitalOcean pricing in USD)
export const CLOUD_BENCHMARK_RATES_USD = {
  CPU_CORE_HOUR: 0.025,       // $0.025 per CPU core-hour
  RAM_GB_HOUR: 0.005,         // $0.005 per GB RAM-hour
  BANDWIDTH_WEB_GB: 0.08,     // $0.08 per GB web bandwidth
  DVPN_TRAFFIC_GB: 0.15,      // $0.15 per GB encrypted residential VPN egress
  FCC_COMPUTE_UNIT_USD: 0.20, // $0.20 USD per Foxy Compute Credit (1 FCC)
  FXC_CREDIT_USD: 0.01        // $0.01 USD per Foxy Credit (1 FXC)
};

export class PremiumEngine {
  constructor(sharedSecret = 'foxy-depin-cluster-shared-secret-v1') {
    this.sharedSecret = sharedSecret;
    this.activeSubscriptions = new Map(); // subId -> subscription
    this.treasury = {
      totalRevenueUsd: 1250.00, // Seed bootstrap valuation
      founderProfitUsd: 500.00, // 40%
      donorBackingPoolUsd: 562.50, // 45% backing liquidity
      totalBurnedUsd: 187.50,   // 15%
      foxyTokenFloorPriceUsd: 0.12, // Derived token valuation backed by reserve
      fxcRateUsd: CLOUD_BENCHMARK_RATES_USD.FXC_CREDIT_USD,
      fccRateUsd: CLOUD_BENCHMARK_RATES_USD.FCC_COMPUTE_UNIT_USD,
      totalFccConsumed: 0,
      totalFxcMinted: 125000,
      totalFoxyBurnedFromVault: 1562.50
    };
    this.foxyFinanceWorkloads = [];
  }

  /**
   * Calculates the exact fair market value in USD of resources donated by a node
   */
  calculateResourceUsdValue({ uptimeSeconds, bytesServed, vpnBytesServed, computeUnits = 0, specs }) {
    const hours = uptimeSeconds / 3600;
    const cores = specs?.cores || 2;
    const ramGb = (specs?.totalRamMb || 2048) / 1024;
    const webGb = bytesServed / (1024 * 1024 * 1024);
    const vpnGb = vpnBytesServed / (1024 * 1024 * 1024);

    const computeVal = (cores * CLOUD_BENCHMARK_RATES_USD.CPU_CORE_HOUR * hours) +
                       (ramGb * CLOUD_BENCHMARK_RATES_USD.RAM_GB_HOUR * hours) +
                       (computeUnits * CLOUD_BENCHMARK_RATES_USD.FCC_COMPUTE_UNIT_USD);
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
   * Processes a premium service purchase (in USD or $FOXY with 20% discount)
   */
  subscribePlan(planId, subscriberAddress, paymentMethod = 'USD', discountPercent = 0) {
    const plan = PREMIUM_PLANS[planId];
    if (!plan) throw new Error(`Plan no reconocido: ${planId}`);

    const subId = `sub-${Math.random().toString(36).slice(2, 9)}`;
    const clampedDiscount = Math.max(0, Math.min(100, Number(discountPercent || 0)));
    const discountFactor = (100 - clampedDiscount) / 100;

    const isFoxyPayment = String(paymentMethod).toUpperCase() === 'FOXY';
    const effectiveUsd = parseFloat((plan.priceUsd * discountFactor).toFixed(2));
    const effectiveFoxy = parseFloat((plan.priceFoxy * discountFactor).toFixed(4));

    // Distribute Revenue (40% Founder / 45% Donor Backing Reserve / 15% Buyback & Burn)
    const founderProfit = (effectiveUsd * REVENUE_DISTRIBUTION.FOUNDER_MARGIN_PERCENT) / 100;
    const donorReserve = (effectiveUsd * REVENUE_DISTRIBUTION.DONOR_BACKING_RESERVE_PERCENT) / 100;
    const burnShare = (effectiveUsd * REVENUE_DISTRIBUTION.DEFLATIONARY_BURN_PERCENT) / 100;

    const burnedFoxyTokens = isFoxyPayment
      ? parseFloat(((effectiveFoxy * REVENUE_DISTRIBUTION.DEFLATIONARY_BURN_PERCENT) / 100).toFixed(4))
      : parseFloat((burnShare / Math.max(0.01, this.treasury.foxyTokenFloorPriceUsd)).toFixed(4));

    this.treasury.totalRevenueUsd += effectiveUsd;
    this.treasury.founderProfitUsd += founderProfit;
    this.treasury.donorBackingPoolUsd += donorReserve;
    this.treasury.totalBurnedUsd += burnShare;
    this.treasury.totalFoxyBurnedFromVault = parseFloat(
      (this.treasury.totalFoxyBurnedFromVault + burnedFoxyTokens).toFixed(4)
    );
    this.treasury.totalFxcMinted += Math.round(effectiveUsd / this.treasury.fxcRateUsd);

    // Recalculate token floor price based on increased treasury backing and reduced supply
    this.updateTokenValuation();

    const subRecord = {
      subId,
      planId,
      planName: plan.name,
      subscriber: subscriberAddress,
      paymentMethod: isFoxyPayment ? 'FOXY' : 'USD',
      discountAppliedPercent: clampedDiscount,
      amountPaid: isFoxyPayment ? effectiveFoxy : effectiveUsd,
      burnedFoxyTokens,
      revenueDistribution: {
        founderProfitUsd: parseFloat(founderProfit.toFixed(2)),
        donorReserveUsd: parseFloat(donorReserve.toFixed(2)),
        burnedUsd: parseFloat(burnShare.toFixed(2)),
        burnedFoxyTokens
      },
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'ACTIVE'
    };

    this.activeSubscriptions.set(subId, subRecord);
    return subRecord;
  }

  /**
   * Ingests computational workloads from Foxy Finance (FCC consumption)
   */
  recordFoxyFinanceCompute({
    workloadName,
    workloadType = 'MONTE_CARLO_VAR',
    computeUnits = 2,
    billingUsd,
    verifiedByNodes = [],
    consensusEpsilon = 0,
    jobMetrics = null,
    timestamp
  }) {
    const fccConsumed = Math.max(1, Number(computeUnits || 2));
    const revenueUsd = billingUsd !== undefined ? Number(billingUsd) : (fccConsumed * this.treasury.fccRateUsd);

    const founderProfit = (revenueUsd * REVENUE_DISTRIBUTION.FOUNDER_MARGIN_PERCENT) / 100;
    const donorReserve = (revenueUsd * REVENUE_DISTRIBUTION.DONOR_BACKING_RESERVE_PERCENT) / 100;
    const burnShare = (revenueUsd * REVENUE_DISTRIBUTION.DEFLATIONARY_BURN_PERCENT) / 100;
    const burnedFoxyTokens = parseFloat(
      (burnShare / Math.max(0.01, this.treasury.foxyTokenFloorPriceUsd)).toFixed(4)
    );

    this.treasury.totalRevenueUsd += revenueUsd;
    this.treasury.founderProfitUsd += founderProfit;
    this.treasury.donorBackingPoolUsd += donorReserve;
    this.treasury.totalBurnedUsd += burnShare;
    this.treasury.totalFccConsumed += fccConsumed;
    this.treasury.totalFoxyBurnedFromVault = parseFloat(
      (this.treasury.totalFoxyBurnedFromVault + burnedFoxyTokens).toFixed(4)
    );

    this.updateTokenValuation();

    const record = {
      id: `ff-job-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      client: 'Foxy Finance DeFi Ecosystem',
      workloadName: workloadName || 'DeFi Arbitrage & Ledger Settlement Engine',
      workloadType,
      computeUnits: fccConsumed,
      fccConsumed,
      revenueUsd: parseFloat(revenueUsd.toFixed(2)),
      founderShareUsd: parseFloat(founderProfit.toFixed(2)),
      donorReserveUsd: parseFloat(donorReserve.toFixed(2)),
      burnedUsd: parseFloat(burnShare.toFixed(2)),
      burnedFoxyTokens,
      verifiedByNodes,
      consensusEpsilon,
      jobMetrics,
      timestamp: timestamp || new Date().toISOString()
    };

    this.foxyFinanceWorkloads.unshift(record);
    if (this.foxyFinanceWorkloads.length > 20) this.foxyFinanceWorkloads.pop();

    return record;
  }

  updateTokenValuation() {
    // Dynamic floor price = Backing pool / active circulating supply adjusted for vault burns
    const effectiveCirculatingSupply = Math.max(100000, 450000 - (this.treasury.totalFoxyBurnedFromVault || 0));
    const derivedPrice = (this.treasury.donorBackingPoolUsd * 100) / effectiveCirculatingSupply;
    this.treasury.foxyTokenFloorPriceUsd = Math.max(0.10, parseFloat((0.10 + derivedPrice * 0.05).toFixed(4)));
  }

  getTreasuryOverview() {
    return {
      treasury: {
        totalRevenueUsd: parseFloat(this.treasury.totalRevenueUsd.toFixed(2)),
        founderProfitUsd: parseFloat(this.treasury.founderProfitUsd.toFixed(2)),
        donorBackingPoolUsd: parseFloat(this.treasury.donorBackingPoolUsd.toFixed(2)),
        totalBurnedUsd: parseFloat(this.treasury.totalBurnedUsd.toFixed(2)),
        foxyTokenFloorPriceUsd: this.treasury.foxyTokenFloorPriceUsd,
        fxcRateUsd: this.treasury.fxcRateUsd,
        fccRateUsd: this.treasury.fccRateUsd,
        totalFccConsumed: this.treasury.totalFccConsumed,
        totalFxcMinted: this.treasury.totalFxcMinted,
        totalFoxyBurnedFromVault: this.treasury.totalFoxyBurnedFromVault
      },
      distributionModel: REVENUE_DISTRIBUTION,
      benchmarkRates: CLOUD_BENCHMARK_RATES_USD,
      plans: PREMIUM_PLANS,
      foxyFinanceRecentCompute: this.foxyFinanceWorkloads.slice(0, 5)
    };
  }
}
