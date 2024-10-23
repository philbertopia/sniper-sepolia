const { ethers } = require('ethers');  // Library for interacting with Ethereum
const axios = require('axios');  // Library for making HTTP requests
const fs = require('fs');  // Node.js file system module
const winston = require('winston');  // Logging library
require('dotenv').config();  // Load environment variables from .env file
const sqlite3 = require('sqlite3').verbose();

// Import configuration
const config = require('./config');  // Load bot configuration

// Setup logger
// This creates a logger that will write to both the console and a log file
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot-polygon.log' })
  ]
});

// Setup provider and wallet for Polygon mainnet
let provider = new ethers.WebSocketProvider(process.env.POLYGON_RPC_URL_WS);
let wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Setup contracts for Polygon
// These are the smart contracts we'll be interacting with

// The factory contract is responsible for creating new token pairs
const factory = new ethers.Contract(
  config.FACTORY_ADDRESS,
  ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'],
  provider
);

// The router contract is used for swapping tokens
const router = new ethers.Contract(
  config.ROUTER_ADDRESS,
  config.ROUTER_ABI,
  wallet
);

// Etherscan API for Polygon
// We use this to check if a contract's source code is verified
const polygpnscanApi = axios.create({
  baseURL: 'https://api.polygonscan.com/api',
  params: {
    apikey: process.env.POLYGONSCAN_API_KEY
  }
});

// Cache for verified contracts
// This helps us avoid making repeated API calls for the same contract
const verifiedContractsCache = new Map();

// Database setup
let db;

// Function to set up the SQLite database
async function setupDatabase() {
  return new Promise((resolve, reject) => {
    // Create or open the database file
    db = new sqlite3.Database('./bot-polygon.db', (err) => {
      if (err) {
        reject(err);
      } else {
        // Create the positions table if it doesn't exist
        db.run(`CREATE TABLE IF NOT EXISTS positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL,
          amount TEXT NOT NULL,
          txHash TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )`, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  });
}

// Function to check if a contract is verified on Etherscan
async function isContractVerified(address) {
    // Check cache first to avoid unnecessary API calls
  if (verifiedContractsCache.has(address)) {
    return verifiedContractsCache.get(address);
  }

  try {
    // Make API call to Etherscan to check contract verification
    const response = await polygpnscanApi.get('', {
      params: {
        module: 'contract',
        action: 'getabi',
        address: address
      }
    });

    // If status is '1', the contract is verified
    const isVerified = response.data.status === '1';
    // Cache the result for future use
    verifiedContractsCache.set(address, isVerified);
    logger.info(`Contract ${address} verification status: ${isVerified}`);
    return isVerified;
  } catch (error) {
    logger.error(`Error checking contract verification on Polygon: ${error.message}`);
    return false;
  }
}

// Function to get the current gas price and increase it by 20%
// This helps ensure our transactions are processed quickly
async function getGasPrice() {
  const gasPrice = await provider.getGasPrice();
  const adjustedGasPrice = gasPrice.mul(120).div(100); // 20% higher than current gas price
  logger.info(`Current gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei, Adjusted: ${ethers.utils.formatUnits(adjustedGasPrice, 'gwei')} gwei`);
  return adjustedGasPrice;
}

// Function to approve the router to spend our tokens
async function approveToken(tokenAddress, amount) {
  const token = new ethers.Contract(tokenAddress, config.ERC20_ABI, wallet);
  logger.info(`Approving ${amount} of token ${tokenAddress} for trading`);
  const tx = await token.approve(config.ROUTER_ADDRESS, amount);
  await tx.wait();
  logger.info(`Approved ${tokenAddress} for trading on Polygon. Transaction hash: ${tx.hash}`);
}

// Function to execute a trade
async function executeTrade(tokenIn, tokenOut, amountIn) {
  const amountOutMin = 0;  // Consider setting a minimum amount out to protect against slippage
  const path = [tokenIn, tokenOut];
  const to = wallet.address;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

  logger.info(`Attempting to execute trade: ${amountIn} ${tokenIn} for ${tokenOut}`);

  try {
    const gasPrice = await getGasPrice();
    // Execute the swap using the Uniswap router
    const tx = await router.swapExactTokensForTokens(
      amountIn,
      amountOutMin,
      path,
      to,
      deadline,
      { gasPrice }
    );
    const receipt = await tx.wait();
    logger.info(`Trade executed on Polygon: ${receipt.transactionHash}`);
    return receipt;
  } catch (error) {
    logger.error(`Trade failed on Polygon: ${error.message}`);
    return null;
  }
}

// Function to check the liquidity of a pair
async function checkLiquidity(pairAddress) {
  const pair = new ethers.Contract(pairAddress, config.PAIR_ABI, provider);
  const reserves = await pair.getReserves();
  const token0 = await pair.token0();
  
  const [reserve0, reserve1] = reserves;
  // Determine which reserve is ETH and which is the token
  const [ethReserve, tokenReserve] = token0.toLowerCase() === config.WETH_ADDRESS.toLowerCase() 
    ? [reserve0, reserve1] 
    : [reserve1, reserve0];

  logger.info(`Liquidity check for pair ${pairAddress}: ETH Reserve: ${ethers.utils.formatEther(ethReserve)} ETH, Token Reserve: ${ethers.utils.formatEther(tokenReserve)} tokens`);

  return {
    ethReserve: ethers.utils.formatEther(ethReserve),
    tokenReserve: ethers.utils.formatEther(tokenReserve)
  };
}

// Main sniping function
async function snipe(pairAddress, tokenAddress) {
  logger.info(`Attempting to snipe ${tokenAddress}`);

  // Check if contract is verified
  const isVerified = await isContractVerified(tokenAddress);
  if (!isVerified) {
    logger.info(`Skipping unverified token: ${tokenAddress}`);
    return;
  }

  logger.info(`Monitoring ${pairAddress} for liquidity...`);
  // Check liquidity
  const { ethReserve, tokenReserve } = await checkLiquidity(pairAddress);
  if (ethReserve < config.ETH_LIQUIDITY_THRESHOLD || tokenReserve < config.TOKEN_LIQUIDITY_THRESHOLD) {
    logger.info(`Insufficient liquidity for ${tokenAddress}. ETH: ${ethReserve}, Token: ${tokenReserve}`);
    return;
  }

  // Approve token for trading
  const amountIn = ethers.utils.parseEther(config.SNIPE_AMOUNT);
  await approveToken(config.WETH_ADDRESS, amountIn);

  // Execute trade
  const receipt = await executeTrade(config.WETH_ADDRESS, tokenAddress, amountIn);
  if (receipt) {
    // Save position to database
    savePosition(tokenAddress, amountIn, receipt.transactionHash);
  }
}

// Function to save a new position
function savePosition(tokenAddress, amount, txHash) {
  const position = {
    token: tokenAddress,
    amount: amount.toString(),
    txHash: txHash,
    timestamp: Date.now()
  };

  db.run(`INSERT INTO positions (token, amount, txHash, timestamp) VALUES (?, ?, ?, ?)`,
    [position.token, position.amount, position.txHash, position.timestamp],
    (err) => {
      if (err) {
        logger.error(`Error saving position to database: ${err.message}`);
      } else {
        logger.info(`Position saved to database: ${JSON.stringify(position)}`);
      }
    }
  );
}

// Function to manage existing positions
async function managePositions() {
  db.all(`SELECT * FROM positions`, [], (err, rows) => {
    if (err) {
      logger.error(`Error reading positions from database: ${err.message}`);
      return;
    }

    logger.info(`Managing ${rows.length} positions`);

    rows.forEach(async (position) => {
      // Check current price
      const amountIn = ethers.utils.parseEther('1'); // 1 token
      const amounts = await router.getAmountsOut(amountIn, [position.token, config.WETH_ADDRESS]);
      const currentPrice = amounts[1];

      // Calculate stop-loss and take-profit prices
      const buyPrice = ethers.BigNumber.from(position.amount);
      const stopLossPrice = buyPrice.mul(100 - config.STOP_LOSS_PERCENTAGE).div(100);
      const takeProfitPrice = buyPrice.mul(100 + config.TAKE_PROFIT_PERCENTAGE).div(100);

      logger.info(`Position ${position.id}: Current price: ${ethers.utils.formatEther(currentPrice)} ETH, Stop-loss: ${ethers.utils.formatEther(stopLossPrice)} ETH, Take-profit: ${ethers.utils.formatEther(takeProfitPrice)} ETH`);

      // If price hits stop-loss or take-profit, sell the position
      if (currentPrice.lte(stopLossPrice) || currentPrice.gte(takeProfitPrice)) {
        // Execute sell
        const receipt = await executeTrade(position.token, config.WETH_ADDRESS, amountIn);
        if (receipt) {
          logger.info(`Position closed for ${position.token}. Tx: ${receipt.transactionHash}`);
          // Remove position from database
          db.run(`DELETE FROM positions WHERE id = ?`, [position.id], (err) => {
            if (err) {
              logger.error(`Error removing position from database: ${err.message}`);
            } else {
              logger.info(`Position ${position.id} removed from database`);
            }
          });
        }
      }
    });
  });
}

// Main function to run the bot
async function main() {
  try {
    logger.info('Setting up database...');
    await setupDatabase();
    logger.info('Database setup complete');

    logger.info('Bot started on Polygon mainnet');
    logger.info('Listening for new pairs...');

    // Listen for new pairs
    factory.on('PairCreated', async (token0, token1, pairAddress, event) => {
      logger.info('New pair created:');
      logger.info(`Token0: ${token0}`);
      logger.info(`Token1: ${token1}`);
      logger.info(`Pair Address: ${pairAddress}`);
      logger.info(`Block Number: ${event.blockNumber}`);
      logger.info(`Transaction Hash: ${event.transactionHash}`);
      logger.info('------------------------');
      // Determine which token to snipe (the non-WETH token)
      const tokenToSnipe = token0 === config.WETH_ADDRESS ? token1 : token0;
      await snipe(pairAddress, tokenToSnipe);
    });

    // Check for recent pairs every 5 minutes
    setInterval(checkRecentPairs, 5 * 60 * 1000);

    // Log current block number every minute
    setInterval(async () => {
      try {
        const blockNumber = await provider.getBlockNumber();
        logger.info(`Current block number: ${blockNumber}`);
      } catch (error) {
        logger.error(`Error getting block number: ${error.message}`);
        reinitializeProvider();
      }
    }, 60000);
    
  } catch (error) {
    logger.error(`Error during bot initialization: ${error.message}`);
    process.exit(1);
  }
}

// Check for recent pair creations
async function checkRecentPairs() {
  try {
    const filter = factory.filters.PairCreated();
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = currentBlock - 10000; // Check last 10000 blocks
    logger.info(`Checking for pairs from block ${fromBlock} to ${currentBlock}`);
    const events = await factory.queryFilter(filter, fromBlock, currentBlock);
    logger.info(`Found ${events.length} pair creation events in the last 10000 blocks`);
    events.forEach(event => {
      logger.info(`Pair created: ${event.args.pair}, Token0: ${event.args.token0}, Token1: ${event.args.token1}, Block: ${event.blockNumber}`);
    });
  } catch (error) {
    logger.error(`Error checking recent pairs: ${error.message}`);
    reinitializeProvider();
  }
}

// Run the main function
main().catch(error => {
  logger.error(`Unhandled error: ${error.message}`);
  process.exit(1);
});

// Handle potential disconnections by periodically checking connection
setInterval(async () => {
  try {
    await provider.getBlockNumber();
  } catch (error) {
    logger.error('Connection error detected. Reinitializing provider...');
    reinitializeProvider();
  }
}, 30000); // Check every 30 seconds

// Add error handling for provider
provider.on("error", (error) => {
    logger.error("WebSocket Error:", error);
});

// Function to reinitialize the provider and contracts
function reinitializeProvider() {
    provider = new ethers.WebSocketProvider(process.env.POLYGON_RPC_URL_WS);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    factory = new ethers.Contract(
        config.FACTORY_ADDRESS,
        ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'],
        provider
    );
    // Reinitialize other contracts here if needed
    
    logger.info('Provider and contracts reinitialized');
}
