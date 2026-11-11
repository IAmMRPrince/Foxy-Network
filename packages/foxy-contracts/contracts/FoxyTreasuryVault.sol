// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./FoxyToken.sol";

/**
 * @title FoxyTreasuryVault
 * @notice Receives payments for premium services and Foxy Finance compute, in
 *         native currency or in $FOXY, and splits them three ways:
 *
 *         - Founder / protocol share (default 40%): paid out immediately.
 *         - Donor reserve (default 45%): held here; the owner disburses it to donors.
 *         - Burn share (default 15%): $FOXY payments burn it on the spot. Native
 *           payments set it aside in `buybackBalance`; the owner withdraws it to
 *           buy $FOXY on a DEX and burn it (this contract has no DEX router).
 *
 *         Nothing in this contract fixes or guarantees a price for $FOXY.
 */
contract FoxyTreasuryVault {
    address public owner;
    address payable public founderWallet;
    FoxyToken public immutable foxyToken;

    // Revenue split in basis points (10000 = 100%)
    uint256 public founderFeeBps = 4000;
    uint256 public donorReserveBps = 4500;
    uint256 public buybackBurnBps = 1500;

    // Native-currency accounting
    uint256 public totalRevenueCollected;
    uint256 public donorReserveBalance; // native currency held for donors
    uint256 public buybackBalance;      // native currency set aside for buyback & burn
    uint256 public totalDonorRewardsDisbursed;

    // $FOXY accounting
    uint256 public totalFoxyCollected;
    uint256 public totalFoxyBurned;
    uint256 public foxyDonorReserve;    // $FOXY held for donors

    mapping(address => uint256) public institutionalVolume;

    struct PremiumPlan {
        string name;
        uint256 price;       // native currency (wei)
        uint256 priceFoxy;   // $FOXY (18 decimals); 0 = not payable in $FOXY
        uint256 durationSec;
        bool isActive;
    }

    mapping(bytes32 => PremiumPlan) public plans;
    // subscriber => planId => timestamp until which the plan is paid
    mapping(address => mapping(bytes32 => uint256)) public subscriptionExpiry;

    // keccak256 of a Foxy Finance tenant id => donor wallet bound to it
    mapping(bytes32 => address) public tenantNodeBinding;

    uint256 private _locked = 1;

    event PremiumPurchased(address indexed subscriber, bytes32 indexed planId, uint256 amount, uint256 paidUntil);
    event PaidWithFoxyToken(address indexed payer, bytes32 indexed planId, uint256 totalFoxy, uint256 burnedFoxy, uint256 paidUntil);
    event FoxyFinanceComputePaid(address indexed entity, uint256 amount, string workloadType);
    event RevenueDistributed(uint256 founderAmount, uint256 donorReserveAmount, uint256 buybackAmount);
    event DonorReserveDisbursed(address indexed to, uint256 nativeAmount, uint256 foxyAmount);
    event BuybackWithdrawn(address indexed to, uint256 amount);
    event FounderWalletUpdated(address indexed previousWallet, address indexed newWallet);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PlanUpdated(bytes32 indexed planId, uint256 price, uint256 priceFoxy, uint256 durationSec, bool isActive);
    event TenantBound(bytes32 indexed tenantIdHash, address indexed donorWallet);

    modifier onlyOwner() {
        require(msg.sender == owner, "FoxyTreasury: caller is not owner");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "FoxyTreasury: reentrant call");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address payable _founderWallet, address _foxyTokenAddress) {
        require(_founderWallet != address(0), "FoxyTreasury: zero address");
        require(_foxyTokenAddress != address(0), "FoxyTreasury: zero token address");
        owner = msg.sender;
        founderWallet = _founderWallet;
        foxyToken = FoxyToken(_foxyTokenAddress);

        _setPlan("PRO_TUNNEL", "Foxy Pro Dedicated Tunnel & Custom SSL", 0.05 ether, 150 ether, 30 days, true);
        _setPlan("ENTERPRISE_DVPN", "Foxy Enterprise dVPN Business Pool", 0.12 ether, 390 ether, 30 days, true);
        _setPlan("FOXY_FINANCE_TRADER_PRO", "Foxy Finance Trader Pro", 0.12 ether, 325 ether, 30 days, true);
        _setPlan("FOXY_FINANCE_INSTITUTIONAL_DESK", "Foxy Finance Institutional Desk", 0.5 ether, 1320 ether, 30 days, true);
    }

    // --- Payments in native currency ---

    /// @notice Pays one period of a plan in native currency. Overpayment is refunded.
    function purchasePremium(bytes32 planId) external payable nonReentrant {
        PremiumPlan storage plan = plans[planId];
        require(plan.isActive, "FoxyTreasury: plan not active");
        require(msg.value >= plan.price, "FoxyTreasury: insufficient payment");

        uint256 paidUntil = _extend(msg.sender, planId, plan.durationSec);
        _distributeRevenue(plan.price);
        emit PremiumPurchased(msg.sender, planId, plan.price, paidUntil);

        uint256 refund = msg.value - plan.price;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            require(ok, "FoxyTreasury: refund failed");
        }
    }

    /// @notice Foxy Finance pays for compute consumed on the network.
    function recordFoxyFinanceComputePayment(string calldata workloadType) external payable nonReentrant {
        require(msg.value > 0, "FoxyTreasury: value must be > 0");
        institutionalVolume[msg.sender] += msg.value;
        _distributeRevenue(msg.value);
        emit FoxyFinanceComputePaid(msg.sender, msg.value, workloadType);
    }

    // --- Payments in $FOXY ---

    /**
     * @notice Pays one period of a plan in $FOXY (approve this contract first).
     *         The burn share is destroyed immediately, the founder share is
     *         forwarded, and the rest stays as the donors' $FOXY reserve.
     */
    function paySubscriptionWithFoxy(bytes32 planId, uint256 foxyAmount) external nonReentrant {
        PremiumPlan storage plan = plans[planId];
        require(plan.isActive, "FoxyTreasury: plan not active");
        require(plan.priceFoxy > 0, "FoxyTreasury: plan not payable in FOXY");
        require(foxyAmount == plan.priceFoxy, "FoxyTreasury: wrong FOXY amount");

        require(foxyToken.transferFrom(msg.sender, address(this), foxyAmount), "FoxyTreasury: FOXY transfer failed");

        uint256 founderShare = (foxyAmount * founderFeeBps) / 10000;
        uint256 burnShare = (foxyAmount * buybackBurnBps) / 10000;
        uint256 reserveShare = foxyAmount - founderShare - burnShare;

        totalFoxyCollected += foxyAmount;
        totalFoxyBurned += burnShare;
        foxyDonorReserve += reserveShare;

        if (burnShare > 0) foxyToken.burnForService(burnShare, "FOXY_FINANCE_SUBSCRIPTION_BURN");
        if (founderShare > 0) {
            require(foxyToken.transfer(founderWallet, founderShare), "FoxyTreasury: founder FOXY transfer failed");
        }

        uint256 paidUntil = _extend(msg.sender, planId, plan.durationSec);
        emit PaidWithFoxyToken(msg.sender, planId, foxyAmount, burnShare, paidUntil);
    }

    function isSubscribed(address subscriber, bytes32 planId) external view returns (bool) {
        return subscriptionExpiry[subscriber][planId] >= block.timestamp;
    }

    // --- Internal ---

    function _extend(address subscriber, bytes32 planId, uint256 durationSec) internal returns (uint256 paidUntil) {
        uint256 current = subscriptionExpiry[subscriber][planId];
        uint256 start = current > block.timestamp ? current : block.timestamp;
        paidUntil = start + durationSec;
        subscriptionExpiry[subscriber][planId] = paidUntil;
    }

    function _distributeRevenue(uint256 totalAmount) internal {
        uint256 founderShare = (totalAmount * founderFeeBps) / 10000;
        uint256 donorReserve = (totalAmount * donorReserveBps) / 10000;
        uint256 buybackShare = totalAmount - founderShare - donorReserve;

        totalRevenueCollected += totalAmount;
        donorReserveBalance += donorReserve;
        buybackBalance += buybackShare;

        (bool successFounder, ) = founderWallet.call{value: founderShare}("");
        require(successFounder, "FoxyTreasury: founder transfer failed");

        emit RevenueDistributed(founderShare, donorReserve, buybackShare);
    }

    // --- Reserve management (owner) ---

    /// @notice Pays a donor out of the reserves. Either amount may be zero.
    function disburseDonorReserve(address payable to, uint256 nativeAmount, uint256 foxyAmount) external onlyOwner nonReentrant {
        require(to != address(0), "FoxyTreasury: zero address");
        require(nativeAmount <= donorReserveBalance, "FoxyTreasury: exceeds native reserve");
        require(foxyAmount <= foxyDonorReserve, "FoxyTreasury: exceeds FOXY reserve");

        donorReserveBalance -= nativeAmount;
        foxyDonorReserve -= foxyAmount;
        totalDonorRewardsDisbursed += nativeAmount;

        if (foxyAmount > 0) require(foxyToken.transfer(to, foxyAmount), "FoxyTreasury: FOXY transfer failed");
        if (nativeAmount > 0) {
            (bool ok, ) = to.call{value: nativeAmount}("");
            require(ok, "FoxyTreasury: native transfer failed");
        }
        emit DonorReserveDisbursed(to, nativeAmount, foxyAmount);
    }

    /// @notice Withdraws the buyback allocation so it can be swapped for $FOXY and burned.
    function withdrawBuyback(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "FoxyTreasury: zero address");
        require(amount <= buybackBalance, "FoxyTreasury: exceeds buyback balance");
        buybackBalance -= amount;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "FoxyTreasury: transfer failed");
        emit BuybackWithdrawn(to, amount);
    }

    // --- Administration ---

    function setPlan(bytes32 planId, string calldata name, uint256 price, uint256 priceFoxy, uint256 durationSec, bool isActive) external onlyOwner {
        _setPlan(planId, name, price, priceFoxy, durationSec, isActive);
    }

    function _setPlan(bytes32 planId, string memory name, uint256 price, uint256 priceFoxy, uint256 durationSec, bool isActive) internal {
        require(price > 0 && durationSec > 0, "FoxyTreasury: invalid plan");
        plans[planId] = PremiumPlan(name, price, priceFoxy, durationSec, isActive);
        emit PlanUpdated(planId, price, priceFoxy, durationSec, isActive);
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

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FoxyTreasury: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Records on-chain which donor wallet a Foxy Finance tenant is bound to.
    ///         Pass the zero address to remove the binding.
    function bindFoxyFinanceTenant(bytes32 tenantIdHash, address donorWallet) external onlyOwner {
        tenantNodeBinding[tenantIdHash] = donorWallet;
        emit TenantBound(tenantIdHash, donorWallet);
    }

    /// @notice Plain transfers are treated as revenue and split like any payment.
    receive() external payable nonReentrant {
        _distributeRevenue(msg.value);
    }
}
