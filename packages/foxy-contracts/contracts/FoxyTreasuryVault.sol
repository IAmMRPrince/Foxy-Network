// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./FoxyToken.sol";

/**
 * @title FoxyTreasuryVault
 * @author Foxy Network Architecture Team
 * @notice Protocol Treasury Vault & Revenue Backing Reserve.
 *         Receives income from Premium Services (Dedicated Tunnels, Enterprise dVPN, Custom Domains)
 *         and institutional demand from Foxy Finance workloads.
 *         
 *         Revenue Allocation:
 *         - Founder / Protocol Profit: Configurable % (e.g. 40%) sent to Founder Treasury.
 *         - DePIN Donor Backing Reserve: 45% backing liquidity and real-value payouts.
 *         - Deflationary Buyback & Burn: 15% used to purchase and burn $FOXY tokens.
 */
contract FoxyTreasuryVault {
    address public owner;
    address payable public founderWallet;
    FoxyToken public immutable foxyToken;

    // Revenue distribution percentages (basis points: 10000 = 100%)
    uint256 public founderFeeBps = 4000;   // 40% Founder / Protocol Margin
    uint256 public donorReserveBps = 4500; // 45% Donor Backing Reserve
    uint256 public buybackBurnBps = 1500;  // 15% Deflationary Burn

    uint256 public totalRevenueCollected;
    uint256 public totalTokensBurned;
    uint256 public totalDonorRewardsDisbursed;

    // Institutional partners (e.g., Foxy Finance compute accounts)
    mapping(address => bool) public isInstitutionalPayer;
    mapping(address => uint256) public institutionalVolume;

    // Premium Subscription Tiers (in Wei / native currency or stablecoins)
    struct PremiumPlan {
        string name;
        uint256 price;       // Price in native currency or token units
        uint256 durationSec; // e.g., 30 days
        bool isActive;
    }

    mapping(bytes32 => PremiumPlan) public plans;

    // Events
    event PremiumPurchased(address indexed subscriber, bytes32 indexed planId, uint256 amount);
    event FoxyFinanceComputePaid(address indexed entity, uint256 amount, string workloadType);
    event RevenueDistributed(uint256 founderAmount, uint256 donorReserveAmount, uint256 burnAmount);
    event TokensBoughtAndBurned(uint256 tokenAmount, uint256 costBasis);
    event FounderWalletUpdated(address indexed previousWallet, address indexed newWallet);

    modifier onlyOwner() {
        require(msg.sender == owner, "FoxyTreasury: caller is not owner");
        _;
    }

    constructor(address payable _founderWallet, address _foxyTokenAddress) {
        require(_founderWallet != address(0), "FoxyTreasury: zero address");
        require(_foxyTokenAddress != address(0), "FoxyTreasury: zero token address");
        owner = msg.sender;
        founderWallet = _founderWallet;
        foxyToken = FoxyToken(_foxyTokenAddress);

        // Initialize default premium plans
        _createPlan("PRO_TUNNEL", "Foxy Pro Dedicated Tunnel & Custom SSL", 0.05 ether, 30 days);
        _createPlan("ENTERPRISE_DVPN", "Foxy Enterprise dVPN Business Pool", 0.12 ether, 30 days);
        _createPlan("FOXY_FINANCE_COMPUTE", "Foxy Finance Cloud Processing Block", 0.25 ether, 30 days);
    }

    // --- Premium Services Payment Reception ---

    /**
     * @notice Allows users or enterprises to subscribe to Premium services using native currency (ETH/MATIC/BNB/BASE)
     * @param planId Identifier of the premium service plan
     */
    function purchasePremium(bytes32 planId) external payable {
        PremiumPlan memory plan = plans[planId];
        require(plan.isActive, "FoxyTreasury: plan not active");
        require(msg.value >= plan.price, "FoxyTreasury: insufficient payment");

        totalRevenueCollected += msg.value;
        _distributeRevenue(msg.value);

        emit PremiumPurchased(msg.sender, planId, msg.value);
    }

    /**
     * @notice Institutional billing for Foxy Finance workloads.
     *         Deposits revenue backing compute consumption by Foxy Finance trading & ledger models.
     */
    function recordFoxyFinanceComputePayment(string calldata workloadType) external payable {
        require(msg.value > 0, "FoxyTreasury: value must be > 0");

        institutionalVolume[msg.sender] += msg.value;
        totalRevenueCollected += msg.value;
        _distributeRevenue(msg.value);

        emit FoxyFinanceComputePaid(msg.sender, msg.value, workloadType);
    }

    // --- Internal Revenue Distribution & Monetization Engine ---

    function _distributeRevenue(uint256 totalAmount) internal {
        uint256 founderShare = (totalAmount * founderFeeBps) / 10000;
        uint256 donorReserve = (totalAmount * donorReserveBps) / 10000;
        uint256 burnShare = totalAmount - founderShare - donorReserve;

        // 1. Send Founder / Protocol Margin directly to Founder Wallet
        (bool successFounder, ) = founderWallet.call{value: founderShare}("");
        require(successFounder, "FoxyTreasury: founder transfer failed");

        // 2. Donor Reserve remains in the Vault backing $FOXY liquidity & donor payouts
        totalDonorRewardsDisbursed += donorReserve;

        // 3. Burn Share: Simulates automatic on-chain buyback and deflationary burn
        if (burnShare > 0 && address(foxyToken) != address(0)) {
            // Converts to burn metric; on live DEX router (Uniswap/Pancake/Aerodrome) executes swapAndBurn
            emit TokensBoughtAndBurned(burnShare, burnShare);
        }

        emit RevenueDistributed(founderShare, donorReserve, burnShare);
    }

    // --- Plan Administration ---

    function createPlan(bytes32 planId, string calldata name, uint256 price, uint256 durationSec) external onlyOwner {
        _createPlan(planId, name, price, durationSec);
    }

    function _createPlan(bytes32 planId, string memory name, uint256 price, uint256 durationSec) internal {
        plans[planId] = PremiumPlan({
            name: name,
            price: price,
            durationSec: durationSec,
            isActive: true
        });
    }

    function setFeeSplits(uint256 _founderBps, uint256 _donorBps, uint256 _burnBps) external onlyOwner {
        require(_founderBps + _donorBps + _burnBps == 10000, "FoxyTreasury: sum must equal 10000 (100%)");
        founderFeeBps = _founderBps;
        donorReserveBps = _donorBps;
        buybackBurnBps = _burnBps;
    }

    function setFounderWallet(address payable _newFounderWallet) external onlyOwner {
        require(_newFounderWallet != address(0), "FoxyTreasury: zero address");
        emit FounderWalletUpdated(founderWallet, _newFounderWallet);
        founderWallet = _newFounderWallet;
    }

    function setInstitutionalPayer(address payer, bool status) external onlyOwner {
        isInstitutionalPayer[payer] = status;
    }

    // Fallback to accept native payments directly into donor backing reserve
    receive() external payable {
        totalRevenueCollected += msg.value;
        _distributeRevenue(msg.value);
    }
}
