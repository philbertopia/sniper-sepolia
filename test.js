const { ethers } = require('ethers');
require('dotenv').config();

// QuickSwap factory address on Polygon
const FACTORY_ADDRESS = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';

// Factory ABI (only the PairCreated event)
const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)'
];

console.log('WebSocket URL:', process.env.POLYGON_RPC_URL_WS);
console.log('Connecting to Polygon network...');

// Connect to Polygon network
const provider = new ethers.WebSocketProvider(process.env.POLYGON_RPC_URL_WS);

// Add error handling
provider.on("error", (error) => {
    console.error("WebSocket Error:", error);
});

// Create contract instance
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

console.log('Starting to scan for new pairs on Polygon...');

// Listen for PairCreated events
factory.on('PairCreated', (token0, token1, pairAddress, event) => {
  console.log('New pair created:');
  console.log('Token0:', token0);
  console.log('Token1:', token1);
  console.log('Pair Address:', pairAddress);
  console.log('Block Number:', event.blockNumber);
  console.log('Transaction Hash:', event.transactionHash);
  console.log('------------------------');
});

// Check for recent pairs
async function checkRecentPairs() {
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = currentBlock - 10000; // Check last 10000 blocks

  console.log(`Checking for pairs from block ${fromBlock} to ${currentBlock}`);

  const filter = factory.filters.PairCreated();
  const events = await factory.queryFilter(filter, fromBlock, currentBlock);

  console.log(`Found ${events.length} pair creation events in the last 10000 blocks`);

  events.forEach((event, index) => {
    console.log(`Pair ${index + 1}:`);
    console.log('Token0:', event.args.token0);
    console.log('Token1:', event.args.token1);
    console.log('Pair Address:', event.args.pair);
    console.log('Block Number:', event.blockNumber);
    console.log('Transaction Hash:', event.transactionHash);
    console.log('------------------------');
  });
}

// Run the recent pairs check
checkRecentPairs().catch(console.error);

// Keep the script running
process.on('SIGINT', () => {
  console.log('Stopping the scanner...');
  process.exit();
});
