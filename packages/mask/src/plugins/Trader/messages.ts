import { createPluginMessage, createPluginRPC, PluginMessageEmitter } from '@masknet/plugin-infra'
import type { GasConfig } from '@masknet/web3-shared-evm'
import type { SourceType } from '@masknet/web3-shared-base'
import { PLUGIN_ID } from './constants/index.js'
import type { TagType } from './types/index.js'

interface TrendingAnchorEvent {
    name: string
    type: TagType
    element: HTMLElement | null
    dataProviders?: SourceType[]
    address?: string
    isNFTProjectPopper?: boolean
}

interface SwapSettingsEvent {
    open: boolean
    gasConfig?: GasConfig
}

export interface TraderMessage {
    /**
     * View a cash tag
     */
    trendingAnchorObserved: TrendingAnchorEvent

    /**
     * Swap settings dialog
     */
    swapSettingsUpdated: SwapSettingsEvent

    rpc: unknown
}

if (import.meta.webpackHot) import.meta.webpackHot.accept()
export const PluginTraderMessages: PluginMessageEmitter<TraderMessage> = createPluginMessage(PLUGIN_ID)
export const PluginTraderRPC = createPluginRPC(PLUGIN_ID, () => import('./services.js'), PluginTraderMessages.rpc)
