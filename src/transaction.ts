import { t } from '@lokavaluto/lokapi'
import { BridgeObject, Transaction } from '@lokavaluto/lokapi/build/backend'


export function isReconversion(jsonData, backend) {
    if (jsonData.direction !== 1) return false
    const recipient = jsonData['addr_to']
    const safeWallet = backend.jsonData?.safe_wallet_recipient
    if (!safeWallet) return false
    return (
        recipient ===
            '0x' + safeWallet.monujo_backends[backend.internalId][0]
    )
}


export class ComchainTransaction extends Transaction implements t.ITransaction {

    get amount () {
        return (this.jsonData.comchain.amount / 100.0).toString()
    }

    get currency () {
        return this.backends.comchain.customization.cfg.server.currencies.CUR
    }

    get pending () {
        return this.jsonData.comchain.status !== 0
    }

    get date () {
        return new Date(this.jsonData.comchain.time * 1000)
    }

    get description () {
        if (this.parent.parent.jsonData.message_key) {
            try {
                const data = this.backends.comchain.jsc3l.memo.getTransactionMemo(
                    this.jsonData.comchain,
                    `0x${this.parent.parent.jsonData.wallet.address}`,
                    this.parent.parent.jsonData.message_key
                )
                return data
            } catch (err) {
                console.error("Couldn't decipher transaction message.")
            }
        }
        return ''
    }

    get id () {
        return this.jsonData.comchain.hash
    }

    get related () {
        const direction = this.jsonData.comchain.direction === 2
        let add = this.jsonData.comchain[direction ? 'addr_from' : 'addr_to']
        if (add === 'Admin') {
            return 'Admin'
        }
        return this.jsonData.odoo.addressResolve[add.substring(2)]?.public_name || add
    }

    get isTopUp () {
        if (this.jsonData.comchain.direction !== 2) return false

        const sender = this.jsonData.comchain['addr_from']
        if (sender === 'Admin') return true

        const safeWallet = this.parent.parent.jsonData?.safe_wallet_recipient
        if (!safeWallet) return false

        let backend = this.parent.parent
        return (
            sender ===
            '0x' + safeWallet.monujo_backends[backend.internalId][0]
        )
    }

    get isReconversion () {
        const backend = this.parent.parent
        if (!isReconversion(this.jsonData.comchain, backend)) {
            return false
        }

        const backendInternalId = backend.internalId.replace(":", "://")
        return this.jsonData.odoo.reconversionStatusResolve[`${backendInternalId}/tx/${this.id}`] || true
    }

}
