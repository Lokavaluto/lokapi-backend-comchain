import { t } from '@lokavaluto/lokapi'

import { ComchainRecipient } from "./recipient"

import { BridgeObject } from '@lokavaluto/lokapi/build/backend'


export class ComchainAccount extends BridgeObject implements t.IAccount {

    get creditable() {
        return this.type === 'Nant'
    }

    get type() {
        return this.jsonData.comchain.type
    }

    async getBalance () {
        const cc = this.backends.comchain
        const wid = this.parent.jsonData.wallet.address
        return await cc.bcRead[`get${this.jsonData.comchain.type}Balance`](wid)
    }

    public async getSymbol () {
        let currencies = this.backends.comchain.customization.getCurrencies()
        return currencies.CUR
    }

    public async getCurrencyName () {
        let type = this.type
        let currencies = this.backends.comchain.customization.getCurrencies()
        if (type == "Nant") {
            return currencies['CUR_nanti']
        } else if (type == "Cm") {
            return currencies['CUR_credit_mut']
        } else {
            throw new Error(`Unexpected type ${this.type} for account`)
        }
    }

    get internalId () {
        return `${this.parent.internalId}/${this.type}`
    }

    public async transfer (recipient: ComchainRecipient, amount: number, description: string) {
        // On comchain, account transfer is managed through the owner account
        return recipient.transfer(amount, description)
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
        return this.backends.odoo.$post('/comchain/credit', {
            comchain_address: wid,
            amount,
        })
    }

}
