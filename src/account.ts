import { t } from '@lokavaluto/lokapi'

import { ComchainRecipient } from './recipient'

import Account from '@lokavaluto/lokapi/build/backend/odoo/account'

import { ttlcache, singleton } from './cache'


export class ComchainAccount extends Account implements t.IAccount {

    @singleton
    get creditable () {
        return this.type === 'Nant'
    }

    @singleton
    get type () {
        return this.jsonData.comchain.type
    }

    @singleton
    get isBarter() {
        return this.type === 'Cm'
    }

    @ttlcache({ttl: 1})
    async getBalance (blockNb: string | number = 'pending') {
        const cc = this.backends.comchain
        const wid = this.parent.jsonData.wallet.address
        return await cc.bcRead[`get${this.jsonData.comchain.type}Balance`](wid, blockNb)
    }

    public async getSymbol () {
        let currencies = this.backends.comchain.customization.getCurrencies()
        return currencies.CUR
    }

    @ttlcache({ttl: 30})
    public async getLowLimit (blockNb: string | number = 'pending') {
        if (this.type !== 'Cm') {
            return null
        }

        const cc = this.backends.comchain
        const wid = this.parent.jsonData.wallet.address
        return await cc.bcRead.getCmLimitBelow(wid, blockNb)
    }

    @ttlcache({ttl: 30})
    public async getHighLimit () {
        if (this.type !== 'Cm') {
            return null
        }

        const cc = this.backends.comchain
        const wid = this.parent.jsonData.wallet.address
        return await cc.bcRead.getCmLimitAbove(wid)
    }

    @singleton
    public async getCurrencyName () {
        let type = this.type
        let currencies = this.backends.comchain.customization.getCurrencies()
        if (type === 'Nant') {
            return currencies['CUR_nanti']
        } else if (type === 'Cm') {
            return currencies['CUR_credit_mut']
        } else {
            throw new Error(`Unexpected type ${this.type} for account`)
        }
    }

    @singleton
    get internalId () {
        return `${this.parent.internalId}/${this.type}`
    }

    public async prepareTransfer (
        recipient: t.IRecipient,
        amount: string,
        senderMemo: string,
        recipientMemo: string = senderMemo,
        signal: AbortSignal,
    ) {
        // On comchain, account transfer is managed through the owner account
        return await recipient.prepareTransfer(amount, senderMemo, recipientMemo, signal)
    }


    /**
     * get URL to Credit given amount on current account
     *
     * @throws {RequestFailed, APIRequestFailed, InvalidCredentials, InvalidJson}
     *
     * @returns Object
     */
    public async getCreditUrl (amount: number): Promise<string> {
        const wid = this.parent.jsonData.wallet.address
        if (amount >= 2**46 ) {
            throw new Error('Amount is exceeding limits for safe representation')
        }
        return this.backends.odoo.$post('/comchain/credit', {
            comchain_address: wid,
            amount,
        })
    }

    @ttlcache({ttl: 3})
    public async isBusinessForFinanceBackend () {
        return await this.parent.isBusinessForFinanceBackend()
    }

}
