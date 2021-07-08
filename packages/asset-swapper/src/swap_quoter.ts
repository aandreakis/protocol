import { getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { FillQuoteTransformerOrderType, LimitOrder } from '@0x/protocol-utils';
import { BigNumber, providerUtils } from '@0x/utils';
import Axios, { AxiosInstance } from 'axios';
import { SupportedProvider } from 'ethereum-types';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import * as _ from 'lodash';

import { constants, INVALID_SIGNATURE, KEEP_ALIVE_TTL } from './constants';
import { ERC20BridgeSource, FillData } from './network/types';
import { LiveChain } from './network/chain';
import {
    MarketBuySwapQuote,
    MarketOperation,
    OrderPrunerPermittedFeeTypes,
    RfqRequestOpts,
    SignedNativeOrder,
    SwapQuote,
    SwapQuoteInfo,
    SwapQuoteOrdersBreakdown,
    SwapQuoteRequestOpts,
    SwapQuoterOpts,
    SwapQuoterRfqOpts,
} from './types';
import { assert } from './utils/assert';
import { Chain } from './network/chain';
import { MarketOperationUtils } from './utils/market_operation_utils';
import { SOURCE_FLAGS, ZERO_AMOUNT } from './utils/market_operation_utils/constants';
import { SourceFilters } from './network/source_filters';
import {
    FeeSchedule,
    GetMarketOrdersOpts,
    MarketDepth,
    MarketDepthSide,
    MarketSideLiquidity,
    OptimizedMarketOrder,
    OptimizerResultWithReport,
} from './utils/market_operation_utils/types';
import { ProtocolFeeUtils } from './utils/protocol_fee_utils';
import { QuoteRequestor } from './utils/quote_requestor';
import { QuoteFillResult, simulateBestCaseFill, simulateWorstCaseFill } from './utils/quote_simulation';

export abstract class Orderbook {
    public abstract getOrdersAsync(
        makerToken: string,
        takerToken: string,
        pruneFn?: (o: SignedNativeOrder) => boolean,
    ): Promise<SignedNativeOrder[]>;
    public abstract getBatchOrdersAsync(
        makerTokens: string[],
        takerToken: string,
        pruneFn?: (o: SignedNativeOrder) => boolean,
    ): Promise<SignedNativeOrder[][]>;
    // tslint:disable-next-line:prefer-function-over-method
    public async destroyAsync(): Promise<void> {
        return;
    }
}

// tslint:disable:max-classes-per-file
export class SwapQuoter {
    public readonly orderbook: Orderbook;
    public readonly expiryBufferMs: number;
    public readonly permittedOrderFeeTypes: Set<OrderPrunerPermittedFeeTypes>;
    private readonly _protocolFeeUtils: ProtocolFeeUtils;
    private readonly _marketOperationUtils: MarketOperationUtils;
    private readonly _rfqtOptions?: SwapQuoterRfqOpts;
    private readonly _quoteRequestorHttpClient: AxiosInstance;

    /**
     * Instantiates a new SwapQuoter instance
     * @param   supportedProvider   The Provider instance you would like to use for interacting with the Ethereum network.
     * @param   orderbook           An object that conforms to Orderbook, see type for definition.
     * @param   opts                Initialization opts for the SwapQuoter. See type definition for details.
     *
     * @return  An instance of SwapQuoter
     */
    public static async createAsync(supportedProvider: SupportedProvider, orderbook: Orderbook, opts: Partial<SwapQuoterOpts> = {}): Promise<SwapQuoter> {
        const chain = await LiveChain.createAsync({ provider: providerUtils.standardizeOrThrow(supportedProvider) });
        const contractAddresses = opts.contractAddresses  || getContractAddressesForChainOrThrow(chain.chainId);
        const marketUtils = await MarketOperationUtils.createAsync({
            chain,
            contractAddresses,
            liquidityProviderRegistry: opts.liquidityProviderRegistry,
            tokenAdjacencyGraph: opts.tokenAdjacencyGraph,
        })
        return new SwapQuoter({ ...opts, chain, orderbook, marketUtils });
    }

    protected constructor(opts: {
        chain: Chain,
        orderbook: Orderbook,
        marketUtils: MarketOperationUtils,
    } & Partial<SwapQuoterOpts>) {
        const {
            expiryBufferMs,
            orderbook,
            permittedOrderFeeTypes,
            marketUtils,
            rfqt,
        } = { ...constants.DEFAULT_SWAP_QUOTER_OPTS, ...opts };
        assert.isValidOrderbook('orderbook', orderbook);
        assert.isNumber('expiryBufferMs', expiryBufferMs);
        this.orderbook = orderbook;
        this.expiryBufferMs = expiryBufferMs;
        this.permittedOrderFeeTypes = permittedOrderFeeTypes;

        this._rfqtOptions = rfqt;
        this._protocolFeeUtils = ProtocolFeeUtils.getInstance(
            constants.PROTOCOL_FEE_UTILS_POLLING_INTERVAL_IN_MS,
            opts.ethGasStationUrl,
        );
        this._marketOperationUtils = marketUtils;
        this._quoteRequestorHttpClient = Axios.create({
            httpAgent: new HttpAgent({ keepAlive: true, timeout: KEEP_ALIVE_TTL }),
            httpsAgent: new HttpsAgent({ keepAlive: true, timeout: KEEP_ALIVE_TTL }),
            ...(rfqt ? rfqt.axiosInstanceOpts : {}),
        });
    }

    public async getBatchMarketBuySwapQuoteAsync(
        makerTokens: string[],
        targetTakerToken: string,
        makerTokenBuyAmounts: BigNumber[],
        opts: Partial<SwapQuoteRequestOpts> = {},
    ): Promise<MarketBuySwapQuote[]> {
        makerTokenBuyAmounts.map((a, i) => assert.isBigNumber(`makerAssetBuyAmounts[${i}]`, a));
        let gasPrice: BigNumber;
        if (!!opts.gasPrice) {
            gasPrice = opts.gasPrice;
            assert.isBigNumber('gasPrice', gasPrice);
        } else {
            gasPrice = await this.getGasPriceEstimationOrThrowAsync();
        }

        const allOrders = await this.orderbook.getBatchOrdersAsync(
            makerTokens,
            targetTakerToken,
            this._limitOrderPruningFn,
        );

        // Orders could be missing from the orderbook, so we create a dummy one as a placeholder
        allOrders.forEach((orders: SignedNativeOrder[], i: number) => {
            if (!orders || orders.length === 0) {
                allOrders[i] = [createDummyOrder(makerTokens[i], targetTakerToken)];
            }
        });

        const fullOpts = { ...constants.DEFAULT_SWAP_QUOTE_REQUEST_OPTS, ...opts };
        const optimizerResults = await this._marketOperationUtils.getBatchMarketBuyOrdersAsync(
            allOrders,
            makerTokenBuyAmounts,
            fullOpts as GetMarketOrdersOpts,
        );

        const batchSwapQuotes = await Promise.all(
            optimizerResults.map(async (result, i) => {
                if (result) {
                    const { makerToken, takerToken } = allOrders[i][0].order;
                    return createSwapQuote(
                        result,
                        makerToken,
                        takerToken,
                        MarketOperation.Buy,
                        makerTokenBuyAmounts[i],
                        gasPrice,
                        fullOpts.gasSchedule,
                        fullOpts.bridgeSlippage,
                    );
                } else {
                    return undefined;
                }
            }),
        );
        return batchSwapQuotes.filter(x => x !== undefined) as MarketBuySwapQuote[];
    }

    /**
     * Returns the bids and asks liquidity for the entire market.
     * For certain sources (like AMM's) it is recommended to provide a practical maximum takerAssetAmount.
     * @param   makerTokenAddress The address of the maker asset
     * @param   takerTokenAddress The address of the taker asset
     * @param   takerAssetAmount  The amount to sell and buy for the bids and asks.
     *
     * @return  An object that conforms to MarketDepth that contains all of the samples and liquidity
     *          information for the source.
     */
    public async getBidAskLiquidityForMakerTakerAssetPairAsync(
        makerToken: string,
        takerToken: string,
        takerAssetAmount: BigNumber,
        opts: Partial<SwapQuoteRequestOpts> = {},
    ): Promise<MarketDepth> {
        assert.isString('makerToken', makerToken);
        assert.isString('takerToken', takerToken);
        const sourceFilters = new SourceFilters([], opts.excludedSources, opts.includedSources);

        let [sellOrders, buyOrders] = !sourceFilters.isAllowed(ERC20BridgeSource.Native)
            ? [[], []]
            : await Promise.all([
                  this.orderbook.getOrdersAsync(makerToken, takerToken),
                  this.orderbook.getOrdersAsync(takerToken, makerToken),
              ]);
        if (!sellOrders || sellOrders.length === 0) {
            sellOrders = [createDummyOrder(makerToken, takerToken)];
        }
        if (!buyOrders || buyOrders.length === 0) {
            buyOrders = [createDummyOrder(takerToken, makerToken)];
        }

        const getMarketDepthSide = (marketSideLiquidity: MarketSideLiquidity): MarketDepthSide => {
            const { dexQuotes, nativeOrders } = marketSideLiquidity.quotes;
            const { side } = marketSideLiquidity;

            return [
                ...dexQuotes,
                nativeOrders.map(o => {
                    return {
                        input: side === MarketOperation.Sell ? o.fillableTakerAmount : o.fillableMakerAmount,
                        output: side === MarketOperation.Sell ? o.fillableMakerAmount : o.fillableTakerAmount,
                        fillData: o,
                        source: ERC20BridgeSource.Native,
                    };
                }),
            ];
        };
        const [bids, asks] = await Promise.all([
            this._marketOperationUtils.getMarketBuyLiquidityAsync(buyOrders, takerAssetAmount, opts),
            this._marketOperationUtils.getMarketSellLiquidityAsync(sellOrders, takerAssetAmount, opts),
        ]);
        return {
            bids: getMarketDepthSide(bids),
            asks: getMarketDepthSide(asks),
            makerTokenDecimals: asks.makerTokenDecimals,
            takerTokenDecimals: asks.takerTokenDecimals,
        };
    }

    /**
     * Returns the recommended gas price for a fast transaction
     */
    public async getGasPriceEstimationOrThrowAsync(): Promise<BigNumber> {
        return this._protocolFeeUtils.getGasPriceEstimationOrThrowAsync();
    }

    /**
     * Destroys any subscriptions or connections.
     */
    public async destroyAsync(): Promise<void> {
        await this._protocolFeeUtils.destroyAsync();
        await this.orderbook.destroyAsync();
    }

    /**
     * Get a `SwapQuote` containing all information relevant to fulfilling a swap between a desired ERC20 token address and ERC20 owned by a provided address.
     * You can then pass the `SwapQuote` to a `SwapQuoteConsumer` to execute a buy, or process SwapQuote for on-chain consumption.
     * @param   makerToken       The address of the maker asset
     * @param   takerToken       The address of the taker asset
     * @param   assetFillAmount  If a buy, the amount of maker asset to buy. If a sell, the amount of taker asset to sell.
     * @param   marketOperation  Either a Buy or a Sell quote
     * @param   opts          Options for the request. See type definition for more information.
     *
     * @return  An object that conforms to SwapQuote that satisfies the request. See type definition for more information.
     */
    public async getSwapQuoteAsync(
        makerToken: string,
        takerToken: string,
        assetFillAmount: BigNumber,
        marketOperation: MarketOperation,
        opts: Partial<SwapQuoteRequestOpts>,
    ): Promise<SwapQuote> {
        assert.isETHAddressHex('makerToken', makerToken);
        assert.isETHAddressHex('takerToken', takerToken);
        assert.isBigNumber('assetFillAmount', assetFillAmount);
        const fullOpts = _.merge({}, constants.DEFAULT_SWAP_QUOTE_REQUEST_OPTS, opts);
        let gasPrice: BigNumber;
        if (!!fullOpts.gasPrice) {
            gasPrice = fullOpts.gasPrice;
            assert.isBigNumber('gasPrice', gasPrice);
        } else {
            gasPrice = await this.getGasPriceEstimationOrThrowAsync();
        }

        const sourceFilters = new SourceFilters([], fullOpts.excludedSources, fullOpts.includedSources);

        fullOpts.rfqt = this._validateRfqtOpts(sourceFilters, fullOpts.rfqt);
        const rfqtOptions = this._rfqtOptions;

        // Get SRA orders (limit orders)
        const shouldSkipOpenOrderbook =
            !sourceFilters.isAllowed(ERC20BridgeSource.Native) ||
            (fullOpts.rfqt && fullOpts.rfqt.nativeExclusivelyRFQ === true);
        const nativeOrders = shouldSkipOpenOrderbook
            ? await Promise.resolve([])
            : await this.orderbook.getOrdersAsync(makerToken, takerToken, this._limitOrderPruningFn);

        // if no native orders, pass in a dummy order for the sampler to have required metadata for sampling
        if (nativeOrders.length === 0) {
            nativeOrders.push(createDummyOrder(makerToken, takerToken));
        }

        //  ** Prepare opts for fetching market side liquidity **
        // Scale fees by gas price.
        const cloneOpts = _.omit(fullOpts, 'gasPrice') as GetMarketOrdersOpts;
        const calcOpts: GetMarketOrdersOpts = {
            ...cloneOpts,
            feeSchedule: _.mapValues(fullOpts.feeSchedule, gasCost => (fillData: FillData) =>
                gasCost === undefined ? 0 : gasPrice.times(gasCost(fillData)),
            ),
            exchangeProxyOverhead: (...args) => gasPrice.times(fullOpts.exchangeProxyOverhead(...args)),
        };
        // pass the QuoteRequestor on if rfqt enabled
        if (calcOpts.rfqt !== undefined) {
            calcOpts.rfqt.quoteRequestor = new QuoteRequestor(
                rfqtOptions ? rfqtOptions.makerAssetOfferings || {} : {},
                {},
                this._quoteRequestorHttpClient,
                rfqtOptions ? rfqtOptions.altRfqCreds : undefined,
                rfqtOptions ? rfqtOptions.warningLogger : undefined,
                rfqtOptions ? rfqtOptions.infoLogger : undefined,
                this.expiryBufferMs,
            );
        }

        const result: OptimizerResultWithReport = await this._marketOperationUtils.getOptimizerResultAsync(
            nativeOrders,
            assetFillAmount,
            marketOperation,
            calcOpts,
        );

        const swapQuote = createSwapQuote(
            result,
            makerToken,
            takerToken,
            marketOperation,
            assetFillAmount,
            gasPrice,
            fullOpts.gasSchedule,
            fullOpts.bridgeSlippage,
        );

        // Use the raw gas, not scaled by gas price
        const exchangeProxyOverhead = fullOpts.exchangeProxyOverhead(
            result.sourceFlags,
            result.numDistinctFills,
        ).toNumber();
        swapQuote.bestCaseQuoteInfo.gas += exchangeProxyOverhead;
        swapQuote.worstCaseQuoteInfo.gas += exchangeProxyOverhead;

        return swapQuote;
    }

    private readonly _limitOrderPruningFn = (limitOrder: SignedNativeOrder) => {
        const order = new LimitOrder(limitOrder.order);
        const isOpenOrder = order.taker === constants.NULL_ADDRESS;
        const willOrderExpire = order.willExpire(this.expiryBufferMs / constants.ONE_SECOND_MS); // tslint:disable-line:boolean-naming
        const isFeeTypeAllowed =
            this.permittedOrderFeeTypes.has(OrderPrunerPermittedFeeTypes.NoFees) &&
            order.takerTokenFeeAmount.eq(constants.ZERO_AMOUNT);
        return isOpenOrder && !willOrderExpire && isFeeTypeAllowed;
    }; // tslint:disable-line:semicolon

    private _isApiKeyWhitelisted(apiKey: string | undefined): boolean {
        if (!apiKey) {
            return false;
        }
        const whitelistedApiKeys = this._rfqtOptions ? this._rfqtOptions.takerApiKeyWhitelist : [];
        return whitelistedApiKeys.includes(apiKey);
    }

    private _isTxOriginBlacklisted(txOrigin: string | undefined): boolean {
        if (!txOrigin) {
            return false;
        }
        const blacklistedTxOrigins = this._rfqtOptions ? this._rfqtOptions.txOriginBlacklist : new Set();
        return blacklistedTxOrigins.has(txOrigin.toLowerCase());
    }

    private _validateRfqtOpts(
        sourceFilters: SourceFilters,
        rfqt: RfqRequestOpts | undefined,
    ): RfqRequestOpts | undefined {
        if (!rfqt) {
            return rfqt;
        }
        // tslint:disable-next-line: boolean-naming
        const { apiKey, nativeExclusivelyRFQ, intentOnFilling, txOrigin } = rfqt;
        // If RFQ-T is enabled and `nativeExclusivelyRFQ` is set, then `ERC20BridgeSource.Native` should
        // never be excluded.
        if (nativeExclusivelyRFQ === true && !sourceFilters.isAllowed(ERC20BridgeSource.Native)) {
            throw new Error('Native liquidity cannot be excluded if "rfqt.nativeExclusivelyRFQ" is set');
        }

        // If an API key was provided, but the key is not whitelisted, raise a warning and disable RFQ
        if (!this._isApiKeyWhitelisted(apiKey)) {
            if (this._rfqtOptions && this._rfqtOptions.warningLogger) {
                this._rfqtOptions.warningLogger(
                    {
                        apiKey,
                    },
                    'Attempt at using an RFQ API key that is not whitelisted. Disabling RFQ for the request lifetime.',
                );
            }
            return undefined;
        }

        // If the requested tx origin is blacklisted, raise a warning and disable RFQ
        if (this._isTxOriginBlacklisted(txOrigin)) {
            if (this._rfqtOptions && this._rfqtOptions.warningLogger) {
                this._rfqtOptions.warningLogger(
                    {
                        txOrigin,
                    },
                    'Attempt at using a tx Origin that is blacklisted. Disabling RFQ for the request lifetime.',
                );
            }
            return undefined;
        }

        // Otherwise check other RFQ opts
        if (
            intentOnFilling && // The requestor is asking for a firm quote
            this._isApiKeyWhitelisted(apiKey) && // A valid API key was provided
            sourceFilters.isAllowed(ERC20BridgeSource.Native) // Native liquidity is not excluded
        ) {
            if (!txOrigin || txOrigin === constants.NULL_ADDRESS) {
                throw new Error('RFQ-T firm quote requests must specify a tx origin');
            }
        }

        return rfqt;
    }
}
// tslint:disable-next-line: max-file-line-count

// begin formatting and report generation functions
function createSwapQuote(
    optimizerResult: OptimizerResultWithReport,
    makerToken: string,
    takerToken: string,
    operation: MarketOperation,
    assetFillAmount: BigNumber,
    gasPrice: BigNumber,
    gasSchedule: FeeSchedule,
    slippage: number,
): SwapQuote {
    const {
        optimizedOrders,
        quoteReport,
        sourceFlags,
        takerAmountPerEth,
        makerAmountPerEth,
        priceComparisonsReport,
    } = optimizerResult;
    const isTwoHop = sourceFlags === SOURCE_FLAGS[ERC20BridgeSource.MultiHop];

    // Calculate quote info
    const { bestCaseQuoteInfo, worstCaseQuoteInfo, sourceBreakdown } = isTwoHop
        ? calculateTwoHopQuoteInfo(optimizedOrders, operation, gasSchedule, slippage)
        : calculateQuoteInfo(optimizedOrders, operation, assetFillAmount, gasPrice, gasSchedule, slippage);

    // Put together the swap quote
    const { makerTokenDecimals, takerTokenDecimals } = optimizerResult.marketSideLiquidity;
    const swapQuote = {
        makerToken,
        takerToken,
        gasPrice,
        orders: optimizedOrders,
        bestCaseQuoteInfo,
        worstCaseQuoteInfo,
        sourceBreakdown,
        makerTokenDecimals,
        takerTokenDecimals,
        takerAmountPerEth,
        makerAmountPerEth,
        quoteReport,
        isTwoHop,
        priceComparisonsReport,
    };

    if (operation === MarketOperation.Buy) {
        return {
            ...swapQuote,
            type: MarketOperation.Buy,
            makerTokenFillAmount: assetFillAmount,
        };
    } else {
        return {
            ...swapQuote,
            type: MarketOperation.Sell,
            takerTokenFillAmount: assetFillAmount,
        };
    }
}

function calculateQuoteInfo(
    optimizedOrders: OptimizedMarketOrder[],
    operation: MarketOperation,
    assetFillAmount: BigNumber,
    gasPrice: BigNumber,
    gasSchedule: FeeSchedule,
    slippage: number,
): { bestCaseQuoteInfo: SwapQuoteInfo; worstCaseQuoteInfo: SwapQuoteInfo; sourceBreakdown: SwapQuoteOrdersBreakdown } {
    const bestCaseFillResult = simulateBestCaseFill({
        gasPrice,
        orders: optimizedOrders,
        side: operation,
        fillAmount: assetFillAmount,
        opts: { gasSchedule },
    });

    const worstCaseFillResult = simulateWorstCaseFill({
        gasPrice,
        orders: optimizedOrders,
        side: operation,
        fillAmount: assetFillAmount,
        opts: { gasSchedule, slippage },
    });

    return {
        bestCaseQuoteInfo: fillResultsToQuoteInfo(bestCaseFillResult),
        worstCaseQuoteInfo: fillResultsToQuoteInfo(worstCaseFillResult),
        sourceBreakdown: getSwapQuoteOrdersBreakdown(bestCaseFillResult.fillAmountBySource),
    };
}

function calculateTwoHopQuoteInfo(
    optimizedOrders: OptimizedMarketOrder[],
    operation: MarketOperation,
    gasSchedule: FeeSchedule,
    slippage: number,
): { bestCaseQuoteInfo: SwapQuoteInfo; worstCaseQuoteInfo: SwapQuoteInfo; sourceBreakdown: SwapQuoteOrdersBreakdown } {
    const [firstHopOrder, secondHopOrder] = optimizedOrders;
    const [firstHopFill] = firstHopOrder.fills;
    const [secondHopFill] = secondHopOrder.fills;
    const gas = new BigNumber(
        gasSchedule[ERC20BridgeSource.MultiHop]!({
            firstHop: _.pick(firstHopFill, 'source', 'fillData'),
            secondHop: _.pick(secondHopFill, 'source', 'fillData'),
        }),
    ).toNumber();
    return {
        bestCaseQuoteInfo: {
            makerAmount: operation === MarketOperation.Sell ? secondHopFill.output : secondHopFill.input,
            takerAmount: operation === MarketOperation.Sell ? firstHopFill.input : firstHopFill.output,
            totalTakerAmount: operation === MarketOperation.Sell ? firstHopFill.input : firstHopFill.output,
            feeTakerTokenAmount: constants.ZERO_AMOUNT,
            protocolFeeInWeiAmount: constants.ZERO_AMOUNT,
            gas,
        },
        // TODO jacob consolidate this with quote simulation worstCase
        worstCaseQuoteInfo: {
            makerAmount: MarketOperation.Sell
                ? secondHopOrder.makerAmount.times(1 - slippage).integerValue()
                : secondHopOrder.makerAmount,
            takerAmount: MarketOperation.Sell
                ? firstHopOrder.takerAmount
                : firstHopOrder.takerAmount.times(1 + slippage).integerValue(),
            totalTakerAmount: MarketOperation.Sell
                ? firstHopOrder.takerAmount
                : firstHopOrder.takerAmount.times(1 + slippage).integerValue(),
            feeTakerTokenAmount: constants.ZERO_AMOUNT,
            protocolFeeInWeiAmount: constants.ZERO_AMOUNT,
            gas,
        },
        sourceBreakdown: {
            [ERC20BridgeSource.MultiHop]: {
                proportion: new BigNumber(1),
                intermediateToken: secondHopOrder.takerToken,
                hops: [firstHopFill.source, secondHopFill.source],
            },
        },
    };
}

function getSwapQuoteOrdersBreakdown(fillAmountBySource: { [source: string]: BigNumber }): SwapQuoteOrdersBreakdown {
    const totalFillAmount = BigNumber.sum(...Object.values(fillAmountBySource));
    const breakdown: SwapQuoteOrdersBreakdown = {};
    Object.entries(fillAmountBySource).forEach(([s, fillAmount]) => {
        const source = s as keyof SwapQuoteOrdersBreakdown;
        if (source === ERC20BridgeSource.MultiHop) {
            // TODO jacob has a different breakdown
        } else {
            breakdown[source] = fillAmount.div(totalFillAmount);
        }
    });
    return breakdown;
}

function fillResultsToQuoteInfo(fr: QuoteFillResult): SwapQuoteInfo {
    return {
        makerAmount: fr.totalMakerAssetAmount,
        takerAmount: fr.takerAssetAmount,
        totalTakerAmount: fr.totalTakerAssetAmount,
        feeTakerTokenAmount: fr.takerFeeTakerAssetAmount,
        protocolFeeInWeiAmount: fr.protocolFeeAmount,
        gas: fr.gas,
    };
}

function createDummyOrder(makerToken: string, takerToken: string): SignedNativeOrder {
    return {
        type: FillQuoteTransformerOrderType.Limit,
        order: {
            ...new LimitOrder({
                makerToken,
                takerToken,
                makerAmount: ZERO_AMOUNT,
                takerAmount: ZERO_AMOUNT,
                takerTokenFeeAmount: ZERO_AMOUNT,
            }),
        },
        signature: INVALID_SIGNATURE,
    };
}
