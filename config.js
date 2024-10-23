const blockchainConfig = require('./blockchain.json');

module.exports = {
    FACTORY_ADDRESS: blockchainConfig.factoryAddress,
    ROUTER_ADDRESS: blockchainConfig.routerAddress,
    WETH_ADDRESS: blockchainConfig.WETHAddress,
    FACTORY_ABI: blockchainConfig.factoryAbi,
    ROUTER_ABI: blockchainConfig.interface,
    PAIR_ABI: [], // You might need to add this if it's used in your bot
    ERC20_ABI: blockchainConfig.erc20Abi,
    STOP_LOSS_PERCENTAGE: 10,
    TAKE_PROFIT_PERCENTAGE: 20,
    ETH_LIQUIDITY_THRESHOLD: 1,
    TOKEN_LIQUIDITY_THRESHOLD: 1000,
    SNIPE_AMOUNT: '0.001', // Amount of Sepolia to use for each snipe
};