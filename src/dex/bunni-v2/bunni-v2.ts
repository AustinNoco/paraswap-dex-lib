import { AsyncOrSync, DeepReadonly } from 'ts-essentials';
import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  PoolLiquidity,
  Logger,
  DexExchangeParam,
} from '../../types';
import {
  SwapSide,
  Network,
  NULL_ADDRESS,
  ETHER_ADDRESS,
} from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { bigIntify, getDexKeysWithNetwork, isETHAddress } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { BunniV2Data, DexParams, PoolState, ProtocolState } from './types';
import { SimpleExchange } from '../simple-exchange';
import { BunniV2Config } from './config';
import { BunniV2EventPool } from './bunni-v2-pool';
import V4QuoterABI from '../../abi/bunni-v2/V4Quoter.abi.json';
import { Interface } from '@ethersproject/abi';
import { MultiResult } from '../../lib/multi-wrapper';
import { BytesLike } from 'ethers';
import { generalDecoder } from '../../lib/decoders';
import { BI_POWS } from '../../bigint-constants';
import _ from 'lodash';
import {
  swapExactInputCalldata,
  swapExactInputSingleCalldata,
  swapExactOutputCalldata,
  swapExactOutputSingleCalldata,
} from './encoder';
import { getAvailablePoolsForToken, updatePricePerVaultShares } from './utils';
import ERC4626ABI from '../../abi//ERC4626.json';
import { TickMath } from './lib/TickMath';

const VAULT_SHARE_PRICES_UPDATE_TTL = 1 * 60; // 1 minute
const BUNNI_V2_GAS_COST = 400_000; // https://dashboard.tenderly.co/shared/simulation/d343cb5e-7d7c-45f8-9653-6a7f7f104eed/gas-usage

export class BunniV2 extends SimpleExchange implements IDex<BunniV2Data> {
  protected eventPools: BunniV2EventPool;

  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = false;
  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(BunniV2Config);

  WETH: string;
  config: DexParams;
  logger: Logger;
  quoterInterface: Interface;
  erc4626Interface: Interface;
  updateVaultSharePricesTimer?: NodeJS.Timeout;

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);

    this.WETH =
      this.dexHelper.config.data.wrappedNativeTokenAddress.toLowerCase();
    this.config = BunniV2Config.BunniV2[network];
    this.logger = dexHelper.getLogger(dexKey);
    this.quoterInterface = new Interface(V4QuoterABI);
    this.erc4626Interface = new Interface(ERC4626ABI);

    this.eventPools = new BunniV2EventPool(
      dexKey,
      network,
      dexHelper,
      this.logger,
    );
  }

  async initializePricing(blockNumber: number) {
    await this.eventPools.initialize(blockNumber);

    if (!this.updateVaultSharePricesTimer) {
      try {
        await this.updateVaultSharePrices();
      } catch (error) {
        this.logger.error(
          `${this.dexKey}: Failed to update vault share prices on initialize:`,
          error,
        );
      }

      this.updateVaultSharePricesTimer = setInterval(async () => {
        try {
          await this.updateVaultSharePrices();
        } catch (error) {
          this.logger.error(
            `${this.dexKey}: Failed to update vault share prices:`,
            error,
          );
        }
      }, VAULT_SHARE_PRICES_UPDATE_TTL * 1000);
    }
  }

  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }

  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    const srcTokenAddress = srcToken.address.toLowerCase();
    const destTokenAddress = destToken.address.toLowerCase();
    const poolState = this.eventPools.getState(blockNumber);

    if (poolState === null) return [];
    return this.findPoolIdentifiersWithTokens(
      poolState,
      srcTokenAddress,
      destTokenAddress,
    );
  }

  findPoolIdentifiersWithTokens(
    pools: DeepReadonly<ProtocolState>,
    srcToken: string,
    destToken: string,
  ): string[] {
    return this.getAvailablePoolsForPair(pools, srcToken, destToken).map(
      (poolState: PoolState) => `BunniV2_${poolState.id}`,
    );
  }

  getAvailablePoolsForPair(
    pools: DeepReadonly<ProtocolState>,
    srcToken: string,
    destToken: string,
  ): PoolState[] {
    const isEthSrc = isETHAddress(srcToken);
    const isEthDest = isETHAddress(destToken);

    const isWethSrc = srcToken.toLowerCase() === this.WETH;
    const isWethDest = destToken.toLowerCase() === this.WETH;

    const _srcToken = isEthSrc ? NULL_ADDRESS : srcToken.toLowerCase();
    const _destToken = isEthDest ? NULL_ADDRESS : destToken.toLowerCase();

    const matchesSrcToken = (poolToken: string): boolean => {
      return (
        poolToken === _srcToken ||
        (isEthSrc && poolToken === this.WETH) ||
        (isWethSrc && poolToken === NULL_ADDRESS)
      );
    };

    const matchesDestToken = (poolToken: string): boolean => {
      return (
        poolToken === _destToken ||
        (isEthDest && poolToken === this.WETH) ||
        (isWethDest && poolToken === NULL_ADDRESS)
      );
    };

    return Object.values(pools.poolStates).filter(pool => {
      const token0 = pool.key.currency0.toLowerCase();
      const token1 = pool.key.currency1.toLowerCase();

      return (
        (matchesSrcToken(token0) && matchesDestToken(token1)) ||
        (matchesSrcToken(token1) && matchesDestToken(token0))
      );
    }) as PoolState[];
  }

  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    limitPools?: string[],
  ): Promise<null | ExchangePrices<BunniV2Data>> {
    const poolStates = this.eventPools.getState(blockNumber);
    if (poolStates === null) return null;

    const _from = this.dexHelper.config.wrapETH(srcToken);
    const _to = this.dexHelper.config.wrapETH(destToken);
    if (_from.address === _to.address) {
      return null;
    }

    const pools = this.getAvailablePoolsForPair(
      poolStates,
      srcToken.address,
      destToken.address,
    );

    const poolIdSet = new Set(limitPools ?? []);
    const availablePools =
      limitPools && limitPools.length
        ? pools.filter(pool => poolIdSet.has(`BunniV2_${pool.id}`))
        : pools;

    const pricesPromises = availablePools.map(async pool => {
      let prices: bigint[] | null;

      const zeroForOne =
        srcToken.address.toLowerCase() === pool.key.currency0.toLowerCase() ||
        (isETHAddress(srcToken.address) &&
          pool.key.currency0 === NULL_ADDRESS) || // ETH is src and native ETH pool
        (isETHAddress(srcToken.address) && pool.key.currency0 === this.WETH) || // ETH is src and WETH pool
        (srcToken.address.toLowerCase() === this.WETH &&
          pool.key.currency0 === NULL_ADDRESS); // WETH is src and native ETH pool

      try {
        prices = await this.getOffChainPrices(
          zeroForOne,
          amounts,
          pool,
          side,
          blockNumber,
        );
      } catch (error) {
        this.logger.warn(
          `[${this.dexKey}-${this.network}] Off-chain pricing failed for pool ${pool.id}: ${error}. Falling back to on-chain`,
        );

        try {
          prices = await this.getOnChainPrices(
            zeroForOne,
            amounts,
            pool,
            side,
            blockNumber,
          );
        } catch (error) {
          this.logger.error(
            `[${this.dexKey}-${this.network}] On-chain pricing failed for pool ${pool.id}: ${error}`,
          );
          prices = null;
        }
      }

      if (prices === null) {
        return null;
      }

      if (prices.every(price => price === 0n || price === 1n)) {
        return null;
      }

      return {
        unit: BI_POWS[destToken.decimals],
        prices,
        data: {
          path: [
            {
              tokenIn: zeroForOne ? pool.key.currency0 : pool.key.currency1,
              tokenOut: zeroForOne ? pool.key.currency1 : pool.key.currency0,
              zeroForOne,
              pool: {
                key: pool.key,
              },
            },
          ],
        },
        exchange: this.dexKey,
        gasCost: BUNNI_V2_GAS_COST,
        poolIdentifier: pool.id,
      };
    });

    const prices = await Promise.all(pricesPromises);
    return prices.filter(res => res !== null);
  }

  async getOffChainPrices(
    zeroForOne: boolean,
    amounts: bigint[],
    pool: PoolState,
    side: SwapSide,
    blockNumber: number,
  ): Promise<bigint[]> {
    // pricing logic requires the block timestamp
    let blockTimestamp: bigint | undefined;

    // if block is the chain head, use the chain head timestamp
    if (blockNumber === this.dexHelper.blockManager.getLatestBlockNumber()) {
      const activeChainHead = this.dexHelper.blockManager.getActiveChainHead();
      if (activeChainHead)
        blockTimestamp = bigIntify(activeChainHead.timestamp);
    }

    // otherwise, get the block timestamp via RPC call
    if (blockTimestamp === undefined) {
      this.logger.warn(
        `${this.dexKey}: fallback to fetching block timestamp via RPC call`,
      );
      const block = await this.dexHelper.provider.getBlock(blockNumber);
      blockTimestamp = bigIntify(block.timestamp);
    }

    const quotes = amounts.map(amount => {
      return this.eventPools._quoteSwap(
        pool,
        {
          zeroForOne,
          amountSpecified: side === SwapSide.SELL ? -amount : amount,
          sqrtPriceLimitX96: zeroForOne
            ? TickMath.MIN_SQRT_PRICE + 1n
            : TickMath.MAX_SQRT_PRICE - 1n,
        },
        bigIntify(blockNumber),
        blockTimestamp,
      );
    });

    return quotes.map(quote =>
      side === SwapSide.SELL ? quote.outputAmount : quote.inputAmount,
    );
  }

  async getOnChainPrices(
    zeroForOne: boolean,
    amounts: bigint[],
    pool: PoolState,
    side: SwapSide,
    blockNumber: number,
  ): Promise<bigint[]> {
    const funcName =
      side === SwapSide.SELL
        ? 'quoteExactInputSingle'
        : 'quoteExactOutputSingle';

    const callData = amounts.map(amount => {
      return {
        target: BunniV2Config.BunniV2[this.network].quoter,
        callData: this.quoterInterface.encodeFunctionData(funcName, [
          [pool.key, zeroForOne, amount, '0x'],
        ]),
        decodeFunction: (
          result: MultiResult<BytesLike> | BytesLike,
        ): bigint => {
          // amountOut, gasEstimate
          return generalDecoder(result, ['uint256', 'uint256'], 0n, value =>
            BigInt(value[0].toString()),
          );
        },
      };
    });

    const results = await this.dexHelper.multiWrapper.tryAggregate(
      false,
      callData,
      blockNumber,
    );

    return results.map(result => (result.success ? result.returnData : 0n));
  }

  getCalldataGasCost(poolPrices: PoolPrices<BunniV2Data>): number | number[] {
    if (poolPrices.data.path.length === 1) {
      return (
        CALLDATA_GAS_COST.DEX_OVERHEAD +
        // poolKey -> currency0
        CALLDATA_GAS_COST.ADDRESS +
        // poolKey -> currency1
        CALLDATA_GAS_COST.ADDRESS +
        // poolKey -> fee
        CALLDATA_GAS_COST.wordNonZeroBytes(3) +
        // poolKey -> tickSpacing
        CALLDATA_GAS_COST.wordNonZeroBytes(3) +
        //poolKey -> hooks
        CALLDATA_GAS_COST.ADDRESS +
        // zeroForOne
        CALLDATA_GAS_COST.BOOL +
        // amountIn
        CALLDATA_GAS_COST.AMOUNT +
        // amountOutMinimum
        CALLDATA_GAS_COST.AMOUNT +
        // hookData
        CALLDATA_GAS_COST.ZERO_BYTE
      );
    } else {
      return (
        CALLDATA_GAS_COST.DEX_OVERHEAD +
        // currency
        CALLDATA_GAS_COST.ADDRESS +
        // amount
        CALLDATA_GAS_COST.AMOUNT +
        // minAmount
        CALLDATA_GAS_COST.AMOUNT +
        //
        poolPrices.data.path.reduce(step => {
          return (
            CALLDATA_GAS_COST.DEX_OVERHEAD +
            // poolKey -> currency0
            CALLDATA_GAS_COST.ADDRESS +
            // poolKey -> currency1
            CALLDATA_GAS_COST.ADDRESS +
            // poolKey -> fee
            CALLDATA_GAS_COST.wordNonZeroBytes(3) +
            // poolKey -> tickSpacing
            CALLDATA_GAS_COST.wordNonZeroBytes(3) +
            //poolKey -> hooks
            CALLDATA_GAS_COST.ADDRESS +
            // zeroForOne
            CALLDATA_GAS_COST.BOOL +
            // amountIn
            CALLDATA_GAS_COST.AMOUNT +
            // amountOutMinimum
            CALLDATA_GAS_COST.AMOUNT +
            // hookData
            CALLDATA_GAS_COST.ZERO_BYTE
          );
        }, 0)
      );
    }
  }

  getDexParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    recipient: Address,
    data: BunniV2Data,
    side: SwapSide,
  ): DexExchangeParam {
    let encodingMethod: (
      srcToken: Address,
      destToken: Address,
      data: BunniV2Data,
      amount1: bigint,
      amount2: bigint,
      recipient: Address,
      wethAddr: string,
    ) => string;

    if (data.path.length === 1 && side === SwapSide.SELL) {
      // Single-hop encoding for SELL side
      encodingMethod = swapExactInputSingleCalldata;
    } else if (data.path.length === 1 && side === SwapSide.BUY) {
      // Single-hop encoding for BUY side
      encodingMethod = swapExactOutputSingleCalldata;
    } else if (data.path.length > 1 && side === SwapSide.SELL) {
      // Multi-hop encoding for SELL side
      encodingMethod = swapExactInputCalldata;
    } else if (data.path.length > 1 && side === SwapSide.BUY) {
      // Multi-hop encoding for BUY side
      encodingMethod = swapExactOutputCalldata;
    } else {
      throw new Error(
        `${this.dexKey}-${this.network}: Logic error for side: ${side}, data.path.length: ${data.path.length}`,
      );
    }

    const exchangeData = encodingMethod(
      srcToken,
      destToken,
      data,
      BigInt(srcAmount),
      side === SwapSide.SELL ? 0n : BigInt(destAmount),
      recipient,
      this.WETH,
    );

    return {
      needWrapNative: this.needWrapNative,
      sendEthButSupportsInsertFromAmount: true,
      dexFuncHasRecipient: true,
      exchangeData,
      targetExchange: this.config.router,
      transferSrcTokenBeforeSwap: isETHAddress(srcToken)
        ? undefined
        : this.config.router,
      skipApproval: true,
    };
  }

  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: BunniV2Data,
    side: SwapSide,
  ): AdapterExchangeParam {
    const payload = '';

    return {
      targetExchange: BunniV2Config.BunniV2[this.network].router,
      payload,
      networkFee: '0',
    };
  }

  updatePoolState(): AsyncOrSync<void> {}

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    let _tokenAddress = tokenAddress.toLowerCase();
    if (isETHAddress(_tokenAddress)) _tokenAddress = NULL_ADDRESS;

    const availablePoolsForToken = await getAvailablePoolsForToken(
      this.dexHelper,
      this.logger,
      this.config,
      _tokenAddress,
    );

    if (!availablePoolsForToken) {
      this.logger.error(
        `Error_${this.dexKey}_Subgraph: couldn't fetch the pools from the subgraph`,
      );
      return [];
    }

    // update pricePerVaultShare vaults for vaults via RPC calls
    let pricePerVaultShares = new Map<
      string,
      {
        address: string;
        vaultDecimals: number;
        underlyingDecimals: number;
        pricePerVaultShare: number;
      }
    >();

    availablePoolsForToken.forEach(pool => {
      if (
        pool.bunniToken.vault0 &&
        !pricePerVaultShares.has(pool.bunniToken.vault0.id.toLowerCase())
      ) {
        pricePerVaultShares.set(pool.bunniToken.vault0.id.toLowerCase(), {
          address: pool.bunniToken.vault0.id.toLowerCase(),
          vaultDecimals: parseInt(pool.bunniToken.vault0.decimals),
          underlyingDecimals: parseInt(pool.currency0.decimals),
          pricePerVaultShare: parseFloat(
            pool.bunniToken.vault0.pricePerVaultShare,
          ),
        });
      }

      if (
        pool.bunniToken.vault1 &&
        !pricePerVaultShares.has(pool.bunniToken.vault1.id.toLowerCase())
      ) {
        pricePerVaultShares.set(pool.bunniToken.vault1.id.toLowerCase(), {
          address: pool.bunniToken.vault1.id.toLowerCase(),
          vaultDecimals: parseInt(pool.bunniToken.vault1.decimals),
          underlyingDecimals: parseInt(pool.currency1.decimals),
          pricePerVaultShare: parseFloat(
            pool.bunniToken.vault1.pricePerVaultShare,
          ),
        });
      }
    });

    await updatePricePerVaultShares(
      this.dexHelper,
      this.erc4626Interface,
      pricePerVaultShares,
    );

    const connectors: PoolLiquidity[] = await Promise.all(
      availablePoolsForToken.map(async pool => {
        const connectorAddress =
          _tokenAddress.toLowerCase() === pool.currency0.id.toLowerCase()
            ? pool.currency1.id.toLowerCase()
            : pool.currency0.id.toLowerCase();

        const connectorDecimals =
          _tokenAddress.toLowerCase() === pool.currency0.id.toLowerCase()
            ? parseInt(pool.currency1.decimals)
            : parseInt(pool.currency0.decimals);

        const rawBalance0 = parseFloat(pool.bunniToken.rawBalance0);
        const rawBalance1 = parseFloat(pool.bunniToken.rawBalance1);

        const reserveBalance0 = pool.bunniToken.vault0
          ? parseFloat(pool.bunniToken.reserve0) *
            (pricePerVaultShares.get(pool.bunniToken.vault0.id.toLowerCase())
              ?.pricePerVaultShare || 0)
          : 0;
        const reserveBalance1 = pool.bunniToken.vault1
          ? parseFloat(pool.bunniToken.reserve1) *
            (pricePerVaultShares.get(pool.bunniToken.vault1.id.toLowerCase())
              ?.pricePerVaultShare || 0)
          : 0;

        const totalBalance0 = rawBalance0 + reserveBalance0;
        const totalBalance1 = rawBalance1 + reserveBalance1;

        let liquidity0 = 0;
        if (parseFloat(pool.currency0.price) > 0) {
          liquidity0 = totalBalance0 * parseFloat(pool.currency0.price);
        } else if (parseFloat(pool.currency1.price) > 0) {
          liquidity0 =
            totalBalance0 *
            parseFloat(pool.priceCurrency1) *
            parseFloat(pool.currency1.price);
        } else {
          const usdTokenAmounts = await this.dexHelper.getUsdTokenAmounts([
            [pool.currency0.id, bigIntify(Math.floor(totalBalance0))],
          ]);
          liquidity0 = usdTokenAmounts[0];
        }

        let liquidity1 = 0;
        if (parseFloat(pool.currency1.price) > 0) {
          liquidity1 = totalBalance1 * parseFloat(pool.currency1.price);
        } else if (parseFloat(pool.currency0.price) > 0) {
          liquidity1 =
            totalBalance1 *
            parseFloat(pool.priceCurrency0) *
            parseFloat(pool.currency0.price);
        } else {
          const usdTokenAmounts = await this.dexHelper.getUsdTokenAmounts([
            [pool.currency1.id, bigIntify(Math.floor(totalBalance1))],
          ]);
          liquidity1 = usdTokenAmounts[0];
        }

        return {
          exchange: this.dexKey,
          address: BunniV2Config.BunniV2[this.network].poolManager,
          connectorTokens: [
            {
              address:
                connectorAddress.toLowerCase() === NULL_ADDRESS
                  ? ETHER_ADDRESS
                  : connectorAddress.toLowerCase(),
              decimals: connectorDecimals,
            },
          ],
          liquidityUSD: liquidity0 + liquidity1,
        };
      }),
    );

    const pools = _.orderBy(connectors, ['liquidityUSD'], ['desc']).slice(
      0,
      limit,
    );
    return pools;
  }

  async updateVaultSharePrices(): Promise<void> {
    await this.eventPools._updateVaultSharePrices();
  }

  releaseResources(): AsyncOrSync<void> {
    if (this.updateVaultSharePricesTimer) {
      clearInterval(this.updateVaultSharePricesTimer);
      this.updateVaultSharePricesTimer = undefined;
      this.logger.info(
        `${this.dexKey}: cleared updateVaultSharePricesTimer before shutting down`,
      );
    }
  }
}
