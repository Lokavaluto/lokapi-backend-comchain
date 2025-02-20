import { t, e } from '@lokavaluto/lokapi'
import { Contact } from '@lokavaluto/lokapi/build/backend/odoo/contact'

import { sleep, queryUntil } from '@lokavaluto/lokapi/build/utils'

import { APIError } from '@com-chain/jsc3l/build/exception'

import { ComchainTransaction } from './transaction'


export class ComchainRecipient extends Contact implements t.IRecipient {

    get backendId () {
        return this.parent.internalId
    }

    get fromUserAccount () {
        return this.backends.comchain
    }

    getSymbol () {
        return this.fromUserAccount.getSymbol()
    }

    public async transfer (
        amount: number,
        senderMemo: string,
        recipientMemo: string = senderMemo,
    ) {
        // XXXvlab: yuck, there need to be a clean up and rationalisation
        //   of these backends and jsonData link madness
        const comchain = this.backends.comchain
        const jsc3l = this.parent.jsc3l
        const wallet = comchain.jsonData.wallet
        const destAddress = this.jsonData.comchain.address
        const messageKey = await jsc3l.ajaxReq.getMessageKey(
            `0x${destAddress}`,
            false,
        )
        if (amount < 0) {
            throw new e.NegativeAmount(
                `Negative amounts for transfer are invalid (amount: ${amount})`,
            )
        }
        if (amount == 0) {
            throw new e.NullAmount('Null amount for transfer is invalid')
        }
        const data = jsc3l.memo.getTxMemoCipheredData(
            wallet.message_key.pub,
            messageKey.public_message_key,
            senderMemo,
            recipientMemo,
        )
        const clearWallet = await this.backends.comchain.unlockWallet()

        let jsonData: t.JsonData
        try {
            jsonData = await jsc3l.bcTransaction.transferNant(
                clearWallet,
                destAddress,
                amount,
                data,
            )
        } catch (err) {
            if (err instanceof APIError) {
                if (err.message === 'Incompatible_Amount') {
                    if (err.data === 'InsufficientNantBalance') {
                        throw new e.InsufficientBalance(
                            'Insufficient fund to afford transfer',
                        )
                    }
                    throw new e.RefusedAmount(
                        'Amount refused by backend (given reason: `${err.data}`)',
                    )
                }
                if (err.message === 'Account_Locked_Error') {
                    throw new e.InactiveAccount(
                        "You can't transfer from/to an inactive account.",
                    )
                }
            }
            throw err
        }

        if (!/^0x[a-fA-F0-9]{64}$/.test(jsonData.toString())) {
            console.error(
                'Unexpected response to transferNant (not a transaction id): ',
                jsonData,
            )
            throw new Error('Transaction ID has invalid format')
        }

        let transactionInfo: t.JsonData
        let totalTime = 0
        while (true) {
            try {
                transactionInfo = await jsc3l.ajaxReq.getTransactionInfo(jsonData);
                break
            } catch (err) {
                totalTime += 500;
                if (totalTime >= 10000) {
                    console.error('Timeout or Confirmation Missing', err);
                    throw new e.PaymentConfirmationMissing(
                        "Couldn't get information on last accepted transaction within 10 seconds."
                    );
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        let reconversionStatusResolve = {}
        reconversionStatusResolve[`${this.backendId}/tx/${transactionInfo.hash}`] = false
        return new ComchainTransaction(
            {
                ...this.backends,
                ...{ comchain: jsc3l },
            },
            this,
            {
                comchain: Object.assign({}, transactionInfo, {
                    amount: -transactionInfo.sent,
                }),
                odoo: {
                    addressResolve: Object.fromEntries([
                        [destAddress, this.jsonData.odoo],
                    ]),
                    reconversionStatusResolve,
                },
            },
        )
    }

    public async validateCreation () {
        const comchain = this.backends.comchain
        const wallet = comchain.jsonData.wallet
        const destAddress = this.jsonData.comchain.address
        const [type, limitMin, limitMax] = [0, -1000, 3000]
        if (!(await this.backends.comchain.hasUserAccountValidationRights())) {
            throw new e.PermissionDenied(
                'You need to be admin to validate creation of wallet',
            )
        }
        const status = await this.parent.jsc3l.bcRead.getAccountStatus(
            destAddress,
        )
        if (status != 1) {
            const clearWallet = await this.backends.comchain.unlockWallet()
            await this.parent.jsc3l.bcTransaction.setAccountParam(
                clearWallet,
                destAddress,
                1,
                type,
                limitMin,
                limitMax
            )
            try {
                queryUntil(
                    () =>
                        this.parent.jsc3l.bcRead.getAccountStatus(destAddress),
                    (res) => res === 1
                )
            } catch (err) {
                if (err instanceof e.TimeoutError) {
                    console.log(
                        'Transaction did not change account status in the expected time frame.'
                    )
                    throw err
                }
                throw err
            }
        } else {
            console.log(
                'Account is already validated, warning administrative backend',
            )
        }
        await this.backends.odoo.activateAccount([
            {
                account_id: `comchain:${destAddress}`,
                recipient_id: this.jsonData.odoo.id,
                data: {
                    type,
                    credit_min: limitMin,
                    credit_max: limitMax,
                }
            }
        ])
    }

    get internalId () {
        return `${this.parent.internalId}/${this.jsonData.comchain.address}`
    }

    /**
     * Discard creation request for this recipient
     *
     * @throws {RequestFailed, APIRequestFailed, InvalidCredentials, InvalidJson}
     *
     * @returns Object
     */
    public async discardCreateRequest (): Promise<void> {
        const address = this.jsonData.comchain.address
        const recipient_id = this.jsonData.odoo.id
        await this.backends.odoo.$post(`/comchain/discard`, {
            accounts: [
                {
                    recipient_id,
                    address,
                },
            ],
        })
    }
}
