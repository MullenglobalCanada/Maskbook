import urlcat from 'urlcat'
import { compact, first, omit } from 'lodash-es'
import type { AbiItem } from 'web3-utils'
import {
    ChainId,
    ContractWallet,
    Create2Factory,
    createContract,
    getSmartPayConstants,
    UserOperation,
} from '@masknet/web3-shared-evm'
import { toBase64, fromHex, EMPTY_LIST, NetworkPluginID } from '@masknet/shared-base'
import { isSameAddress } from '@masknet/web3-shared-base'
import WalletABI from '@masknet/web3-contracts/abis/Wallet.json'
import type { Wallet } from '@masknet/web3-contracts/types/Wallet.js'
import { BUNDLER_ROOT, FUNDER_ROOT, MAX_ACCOUNT_LENGTH } from './constants.js'
import type { BundlerAPI } from '../types/Bundler.js'
import { FunderAPI } from '../types/Funder.js'
import { MulticallAPI } from '../Multicall/index.js'
import { Web3API } from '../EVM/index.js'
import type { ContractAccountAPI } from '../entry-types.js'
import { fetchJSON } from '../entry-helpers.js'

export class SmartPayBundlerAPI implements BundlerAPI.Provider {
    private async healthz() {
        const response = await fetch(urlcat(BUNDLER_ROOT, '/healthz'), {
            method: 'GET',
        })
        const json: BundlerAPI.Healthz = await response.json()

        return {
            ...json,
        }
    }

    private async handle(userOperation: UserOperation) {
        const response = await fetch(urlcat(BUNDLER_ROOT, '/handle'), {
            method: 'POST',
            body: JSON.stringify({
                user_operations: [
                    {
                        ...omit(userOperation, [
                            'initCode',
                            'callData',
                            'callGas',
                            'verificationGas',
                            'preVerificationGas',
                            'maxFeePerGas',
                            'maxPriorityFeePerGas',
                            'paymasterData',
                        ]),
                        nonce: userOperation.nonce?.toFixed() ?? '0',
                        init_code: toBase64(fromHex(userOperation.initCode ?? '0x')),
                        call_data: toBase64(fromHex(userOperation.callData ?? '0x')),
                        call_gas: userOperation.callGas,
                        verification_gas: userOperation.verificationGas,
                        pre_verification_gas: userOperation.preVerificationGas,
                        max_fee_per_gas: userOperation.maxFeePerGas,
                        max_priority_fee_per_gas: userOperation.maxPriorityFeePerGas,
                        paymaster_data: toBase64(fromHex(userOperation.paymasterData ?? '0x')),
                        signature: toBase64(fromHex(userOperation.signature ?? '0x')),
                    },
                ],
            }),
        })
        const { tx_hash, message = 'Unknown Error' }: { tx_hash: string; message?: string } = await response.json()
        if (tx_hash) return tx_hash
        throw new Error(message)
    }

    private async assetChainId(chainId: ChainId) {
        const chainIds = await this.getSupportedChainIds()
        if (!chainIds.includes(chainId)) throw new Error(`Not supported ${chainId}.`)
    }

    async getSigner(chainId: ChainId): Promise<string> {
        await this.assetChainId(chainId)

        const healthz = await this.healthz()
        return healthz.bundler_eoa
    }

    async getSupportedChainIds(): Promise<ChainId[]> {
        const healthz = await this.healthz()
        return [Number.parseInt(healthz.chain_id, 10)] as ChainId[]
    }
    async getSupportedEntryPoints(chainId: ChainId): Promise<string[]> {
        await this.assetChainId(chainId)

        const healthz = await this.healthz()
        return [healthz.entrypoint_contract_address]
    }
    simulateUserOperation(
        chainId: ChainId,
        userOperation: UserOperation,
    ): Promise<{ preOpGas: string; prefund: string }> {
        throw new Error('Method not implemented.')
    }
    async sendUserOperation(chainId: ChainId, userOperation: UserOperation): Promise<string> {
        await this.assetChainId(chainId)

        return this.handle(userOperation)
    }
}

export class SmartPayFunderAPI implements FunderAPI.Provider {
    private async assetChainId(chainId: ChainId) {
        const chainIds = await this.getSupportedChainIds()
        if (!chainIds.includes(chainId)) throw new Error(`Not supported ${chainId}.`)
    }

    private async queryWhiteList(handler: string) {
        return fetchJSON<FunderAPI.WhiteList>(urlcat(FUNDER_ROOT, '/whitelist', { twitterHandler: handler }))
    }

    private async queryOperations(key: FunderAPI.ScanKey, value: string) {
        return fetchJSON<FunderAPI.Operation[]>(urlcat(FUNDER_ROOT, '/operation', { scanKey: key, scanValue: value }))
    }

    async getSupportedChainIds(): Promise<ChainId[]> {
        return [ChainId.Matic, ChainId.Mumbai]
    }

    async fund(chainId: ChainId, proof: FunderAPI.Proof): Promise<FunderAPI.Fund> {
        await this.assetChainId(chainId)

        return fetchJSON<FunderAPI.Fund>(urlcat(FUNDER_ROOT, '/verify'), {
            method: 'POST',
            body: JSON.stringify(proof),
            headers: { 'Content-Type': 'application/json' },
        })
    }

    async verify(handler: string) {
        try {
            const result = await this.queryWhiteList(handler)
            if (result.twitterHandler === handler && result.totalCount > 0) {
                return true
            }
            return false
        } catch {
            return false
        }
    }

    async queryRemainFrequency(handler: string) {
        try {
            const result = await this.queryWhiteList(handler)
            if (!result.totalCount || result.twitterHandler !== handler) return 0
            return result.totalCount - result.usedCount
        } catch {
            return 0
        }
    }

    async queryOperationByOwner(owner: string) {
        try {
            return this.queryOperations(FunderAPI.ScanKey.OwnerAddress, owner)
        } catch {
            return EMPTY_LIST
        }
    }
}

export class SmartPayAccountAPI implements ContractAccountAPI.Provider<NetworkPluginID.PLUGIN_EVM> {
    private web3 = new Web3API()
    private multicall = new MulticallAPI()
    private bundler = new SmartPayBundlerAPI()
    private funder = new SmartPayFunderAPI()

    private async getEntryPoint(chainId: ChainId) {
        const entryPoints = await this.bundler.getSupportedEntryPoints(chainId)
        const entryPoint = first(entryPoints)
        if (!entryPoint) throw new Error('No entry point contract.')
        return entryPoint
    }

    private createWeb3(chainId: ChainId) {
        return this.web3.createSDK(chainId)
    }

    private createWalletContract(chainId: ChainId, address: string) {
        return createContract<Wallet>(this.createWeb3(chainId), address, WalletABI as AbiItem[])
    }

    private async createContractWallet(chainId: ChainId, owner: string) {
        if (!owner) throw new Error('No owner address.')

        const { LOGIC_WALLET_CONTRACT_ADDRESS } = getSmartPayConstants(chainId)
        if (!LOGIC_WALLET_CONTRACT_ADDRESS) throw new Error('No logic wallet contract.')

        const entryPoint = await this.getEntryPoint(chainId)
        return new ContractWallet(chainId, owner, LOGIC_WALLET_CONTRACT_ADDRESS, entryPoint)
    }

    private async createCreate2Factory(chainId: ChainId, owner: string) {
        if (!owner) throw new Error('No owner address.')

        const { CREATE2_FACTORY_CONTRACT_ADDRESS } = getSmartPayConstants(chainId)
        if (!CREATE2_FACTORY_CONTRACT_ADDRESS) throw new Error('No create2 contract.')

        return new Create2Factory(CREATE2_FACTORY_CONTRACT_ADDRESS)
    }

    private createContractAccount(
        chainId: ChainId,
        address: string,
        owner: string,
        creator: string,
        deployed = true,
        funded = false,
    ): ContractAccountAPI.ContractAccount<NetworkPluginID.PLUGIN_EVM> {
        return {
            pluginID: NetworkPluginID.PLUGIN_EVM,
            chainId,
            id: `${NetworkPluginID.PLUGIN_EVM}_${chainId}_${address}`,
            address,
            owner,
            creator,
            deployed,
            funded,
        }
    }

    /**
     * Use the multicall contract to filter non-owned accounts out.
     * @param chainId
     * @param options
     * @returns
     */
    private async getAccountsFromMulticall(chainId: ChainId, owner: string, options: string[]) {
        const contracts = options.map((x) => this.createWalletContract(chainId, x)!)
        const names = Array.from<'owner'>({ length: options.length }).fill('owner')
        const calls = this.multicall.createMultipleContractSingleData(contracts, names, [])
        const results = await this.multicall.call(chainId, contracts, names, calls)

        const owners = compact(results.flatMap((x) => (x.succeed && x.value ? x.value : '')))

        // the owner didn't deploy any account before.
        if (!owners.length) {
            return []
        }

        const operations = await this.funder.queryOperationByOwner(owner)
        return compact(
            owners.map((x, index) => {
                // ensure the contract account has been deployed
                // if (!isValidAddress(x)) return

                return this.createContractAccount(
                    chainId,
                    options[index],
                    owner,
                    owner,
                    true,
                    operations.some((operation) => isSameAddress(operation.walletAddress, x)),
                )
            }),
        )
    }

    /**
     * Query the on-chain changeOwner event from chainbase.
     * @param chainId
     * @param owner
     * @returns
     */
    private async getAccountsFromChainbase(chainId: ChainId, owner: string) {
        // TODO: impl chainbase query
        return []
    }

    async getAccountByNonce(chainId: ChainId, owner: string, nonce: number) {
        const create2Factory = await this.createCreate2Factory(chainId, owner)
        const contractWallet = await this.createContractWallet(chainId, owner)
        const address = create2Factory.derive(contractWallet.initCode, nonce)

        const operations = await this.funder.queryOperationByOwner(owner)

        // TODO: ensure account is deployed
        return this.createContractAccount(
            chainId,
            address,
            owner,
            owner,
            false,
            operations.some((operation) => isSameAddress(operation.walletAddress, address)),
        )
    }

    async getAccountsByOwner(
        chainId: ChainId,
        owner: string,
    ): Promise<Array<ContractAccountAPI.ContractAccount<NetworkPluginID.PLUGIN_EVM>>> {
        const create2Factory = await this.createCreate2Factory(chainId, owner)
        const contractWallet = await this.createContractWallet(chainId, owner)
        const allSettled = await Promise.allSettled([
            this.getAccountsFromMulticall(
                chainId,
                owner,
                create2Factory.deriveUntil(contractWallet.initCode, MAX_ACCOUNT_LENGTH),
            ),
            this.getAccountsFromChainbase(chainId, owner),
        ])
        return allSettled.flatMap((x) => (x.status === 'fulfilled' ? x.value : []))
    }

    async getAccountsByOwners(
        chainId: ChainId,
        owners: string[],
    ): Promise<Array<ContractAccountAPI.ContractAccount<NetworkPluginID.PLUGIN_EVM>>> {
        const allSettled = await Promise.allSettled(owners.map((x) => this.getAccountsByOwner(chainId, x)))
        return allSettled.flatMap((x) => (x.status === 'fulfilled' ? x.value : []))
    }
}
