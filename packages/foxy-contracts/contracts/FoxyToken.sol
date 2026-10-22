// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title FoxyToken ($FOXY)
 * @author Foxy Network Architecture Team
 * @notice Native DePIN Utility, Staking and Gas Token for Foxy Network.
 *         Donors earn $FOXY by donating CPU/RAM and routing encrypted dVPN traffic.
 *         Developers and users burn/spend $FOXY to deploy web servers and consume dVPN bandwidth.
 */
contract FoxyToken {
    // --- ERC-20 Standard Metadata ---
    string public constant name = "Foxy Network Token";
    string public constant symbol = "FOXY";
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10**18; // 1,000,000,000 FOXY Cap

    // Owner / Oracle Controller address authorized to sign proof-of-contribution claims
    address public owner;
    address public networkOracle;

    // Balances and Allowances
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // Nonce tracking to prevent replay attacks on reward claims
    mapping(address => uint256) public userNonces;

    // Events
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event TokensBurned(address indexed burner, uint256 amount, string reason);
    event RewardsClaimed(address indexed donor, uint256 amount, uint256 epoch, uint256 nonce);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "FoxyToken: caller is not the owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == networkOracle || msg.sender == owner, "FoxyToken: caller is not authorized oracle");
        _;
    }

    constructor(address _oracle) {
        require(_oracle != address(0), "FoxyToken: invalid oracle address");
        owner = msg.sender;
        networkOracle = _oracle;

        // Initial Genesis Supply (20% for initial liquidity pool, ecosystem grants, and genesis treasury)
        uint256 initialSupply = 200_000_000 * 10**18;
        _mint(msg.sender, initialSupply);
    }

    // --- Standard ERC-20 Functions ---

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function allowance(address tokenOwner, address spender) public view returns (uint256) {
        return _allowances[tokenOwner][spender];
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= amount, "FoxyToken: transfer amount exceeds allowance");
        unchecked {
            _approve(from, msg.sender, currentAllowance - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    // --- DePIN Proof-of-Contribution (PoC) Claim Mechanism ---

    /**
     * @notice Allows a node donor to claim earned $FOXY tokens using a cryptographic signature
     *         issued by the Foxy Controller network oracle.
     * @param amount Amount of $FOXY tokens earned.
     * @param epoch Network epoch number during which compute/bandwidth was provided.
     * @param signature Cryptographic ECDSA signature from the network Oracle.
     */
    function claimContributionReward(
        uint256 amount,
        uint256 epoch,
        bytes calldata signature
    ) external {
        require(amount > 0, "FoxyToken: reward amount must be > 0");
        require(_totalSupply + amount <= MAX_SUPPLY, "FoxyToken: max supply reached");

        uint256 currentNonce = userNonces[msg.sender];
        bytes32 messageHash = keccak256(
            abi.encodePacked(msg.sender, amount, epoch, currentNonce, block.chainid, address(this))
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );

        address recoveredSigner = _recoverSigner(ethSignedMessageHash, signature);
        require(recoveredSigner == networkOracle, "FoxyToken: invalid cryptographic signature from oracle");

        // Increment nonce to prevent replay attacks
        userNonces[msg.sender] = currentNonce + 1;

        _mint(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount, epoch, currentNonce);
    }

    // --- Deflationary Burn Mechanism ---

    /**
     * @notice Burns tokens to consume cloud server hosting or dVPN bandwidth.
     * @param amount Amount of tokens to permanently destroy.
     * @param reason Description of the cloud service consumed (e.g., "DVPN_BANDWIDTH", "SERVER_HOSTING").
     */
    function burnForService(uint256 amount, string calldata reason) external {
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount, reason);
    }

    /**
     * @notice Allows burning tokens directly.
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount, "USER_BURN");
    }

    // --- Admin & Governance ---

    function setNetworkOracle(address _newOracle) external onlyOwner {
        require(_newOracle != address(0), "FoxyToken: zero address");
        emit OracleUpdated(networkOracle, _newOracle);
        networkOracle = _newOracle;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FoxyToken: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // --- Internal Helpers ---

    function _transfer(address from, address to, uint256 amount) internal {
        require(from != address(0), "FoxyToken: transfer from zero address");
        require(to != address(0), "FoxyToken: transfer to zero address");
        require(_balances[from] >= amount, "FoxyToken: insufficient balance");

        unchecked {
            _balances[from] -= amount;
            _balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address account, uint256 amount) internal {
        require(account != address(0), "FoxyToken: mint to zero address");
        require(_totalSupply + amount <= MAX_SUPPLY, "FoxyToken: supply cap exceeded");

        _totalSupply += amount;
        unchecked {
            _balances[account] += amount;
        }
        emit Transfer(address(0), account, amount);
    }

    function _burn(address account, uint256 amount) internal {
        require(account != address(0), "FoxyToken: burn from zero address");
        require(_balances[account] >= amount, "FoxyToken: insufficient balance to burn");

        unchecked {
            _balances[account] -= amount;
            _totalSupply -= amount;
        }
        emit Transfer(account, address(0), amount);
    }

    function _approve(address tokenOwner, address spender, uint256 amount) internal {
        require(tokenOwner != address(0), "FoxyToken: approve from zero address");
        require(spender != address(0), "FoxyToken: approve to zero address");

        _allowances[tokenOwner][spender] = amount;
        emit Approval(tokenOwner, spender, amount);
    }

    function _recoverSigner(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "FoxyToken: invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
