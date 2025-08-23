import { t, e } from '@lokavaluto/lokapi'
import { BridgeObject, Transaction } from '@lokavaluto/lokapi/build/backend'


export function isReconversion(jsonData, backend) {
    if (jsonData.direction !== 1) return false
    const receiverAddr = jsonData['addr_to']
    return backend.technicalAccountAddrs.includes(receiverAddr)
}


let requiredKeys = new Set(["amount", "status", "time", "hash", "addr_from", "addr_to", "direction", "type"])


export class ComchainTransaction extends Transaction implements t.ITransaction {

    constructor (backends, parent, jsonData) {
        super(backends, parent, jsonData)
        const jsonDataKeys = new Set(Object.keys(jsonData.comchain))
        const diff = new Set([...requiredKeys].filter((key: string) => !jsonDataKeys.has(key)))
        if (diff.size !== 0) {
            console.error("Invalid json data for ComchainTransaction", jsonData.comchain)
            throw new e.InvalidJsonData(`Missing fields in provided json data: ${[...diff].join(", ")}`, jsonData.comchain)
        }
    }

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
        if (this.parent.jsonData.message_key) {
            try {
                const data = this.backends.comchain.jsc3l.memo.getTransactionMemo(
                    this.jsonData.comchain,
                    `0x${this.parent.jsonData.wallet.address}`,
                    this.parent.jsonData.message_key
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

        return this.parent.parent.technicalAccountAddrs.includes(sender)
    }

    get isReconversion () {
        const backend = this.parent.parent
        if (!isReconversion(this.jsonData.comchain, backend)) {
            return false
        }

        const backendInternalId = backend.internalId.replace(":", "://")
        return this.jsonData.odoo.reconversionStatusResolve[`${backendInternalId}/tx/${this.id}`] || true
    }


    get tags () {
        const tags = []
        if (this.jsonData.comchain.type === "Transfer") {
            tags.push("collateralized")
        }
        if (this.jsonData.comchain.type === "TransferCredit") {
            tags.push("barter")
        }
        return tags
    }
}
