import { ContractFunctionObj } from '@0x/base-contract';
import { BigNumber, decodeBytesAsRevertError, logUtils } from '@0x/utils';

import { ERC20BridgeSamplerContract } from '../../wrappers';

import { ERC20BridgeSource, FillData, SourceQuoteOperation } from './types';

export type Parameters<T> = T extends (...args: infer TArgs) => any ? TArgs : never;

export interface SamplerContractCall<
    TFunc extends (...args: any[]) => ContractFunctionObj<any>,
    TFillData extends FillData = FillData
> {
    contract: ERC20BridgeSamplerContract;
    function: TFunc;
    params: Parameters<TFunc>;
    callback?: (callResults: string, fillData: TFillData) => BigNumber[];
    encodeCallback?: (...params: Parameters<TFunc>) => string;
    inputAmountOverride?: () => BigNumber[];
}

export class SamplerContractOperation<
    TFunc extends (...args: any[]) => ContractFunctionObj<any>,
    TFillData extends FillData = FillData
> implements SourceQuoteOperation<TFillData> {
    public readonly source: ERC20BridgeSource;
    public fillData: TFillData;
    public inputAmountOverride?: () => BigNumber[];
    private readonly _samplerContract: ERC20BridgeSamplerContract;
    private readonly _samplerFunction: TFunc;
    private readonly _params: Parameters<TFunc>;
    private readonly _callback?: (callResults: string, fillData: TFillData) => BigNumber[];
    private readonly _encodeCallback?: (...params: Parameters<TFunc>) => string;

    constructor(opts: { source: ERC20BridgeSource; fillData?: TFillData } & SamplerContractCall<TFunc, TFillData>) {
        this.source = opts.source;
        this.fillData = opts.fillData || ({} as TFillData); // tslint:disable-line:no-object-literal-type-assertion
        this._samplerContract = opts.contract;
        this._samplerFunction = opts.function;
        this._params = opts.params;
        this._callback = opts.callback;
        this._encodeCallback = opts.encodeCallback;
        this.inputAmountOverride = opts.inputAmountOverride;
    }

    public encodeCall(): string {
        if (this._encodeCallback !== undefined) {
            return this._encodeCallback(...this._params);
        }
        return this._samplerFunction
            .bind(this._samplerContract)(...this._params)
            .getABIEncodedTransactionData();
    }
    public handleCallResults(callResults: string): BigNumber[] {
        if (this._callback !== undefined) {
            return this._callback(callResults, this.fillData);
        } else {
            return this._samplerContract.getABIDecodedReturnData<BigNumber[]>(this._samplerFunction.name, callResults);
        }
    }
    public handleRevert(callResults: string): BigNumber[] {
        let msg = callResults;
        try {
            msg = decodeBytesAsRevertError(callResults).toString();
        } catch (e) {
            // do nothing
        }
        logUtils.warn(
            `SamplerContractOperation: ${this.source}.${this._samplerFunction.name} reverted ${msg} ${
                this.fillData.takerToken
            }->${this.fillData.makerToken}`,
        );
        // logUtils.warn(`\t${JSON.stringify((this.fillData as any).pool, null, 2)}`);
        return [];
    }
}
