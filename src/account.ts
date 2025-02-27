import { t } from '@lokavaluto/lokapi'

import { ComchainRecipient } from './recipient'

import Account from '@lokavaluto/lokapi/build/backend/odoo/account'


export class ComchainAccount extends Account implements t.IAccount {

    get creditable () {
        return this.type === 'Nant'
    }

    get type () {
        return this.jsonData.comchain.type
    }

    async getBalance (blockNb: string | number = 'pending') {
        const cc = this.backends.comchain
        const wid = this.parent.jsonData.wallet.address
        return await cc.bcRead[`get${this.jsonData.comchain.type}Balance`](wid, blockNb)
    }

    public async getSymbol () {
        let currencies = this.backends.comchain.customization.getCurrencies()
        return currencies.CUR
    }

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

    get internalId () {
        return `${this.parent.internalId}/${this.type}`
    }

    public async transfer (
        recipient: ComchainRecipient,
        amount: number,
        senderMemo: string,
        recipientMemo: string = senderMemo,
    ) {
        // On comchain, account transfer is managed through the owner account
        return recipient.transfer(amount, senderMemo, recipientMemo)
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

}
