import { t, e } from '@lokavaluto/lokapi'
import Recipient from '@lokavaluto/lokapi/build/backend/odoo/recipient'
import { PlannedTransaction } from '@lokavaluto/lokapi/build/backend/odoo/transaction'

import { sleep, queryUntil } from '@lokavaluto/lokapi/build/utils'

import { APIError } from '@com-chain/jsc3l/build/exception'

import { ComchainTransaction } from './transaction'

import { intCents2strAmount, strAmount2intCents } from './helpers'


export class ComchainRecipient extends Recipient implements t.IRecipient {

    get backendId () {
        return this.parent.internalId
    }

    get fromUserAccount () {
        return this.backends.comchain
    }

    get userAccountInternalId () {
        // XXXvlab: should be the second
        return `comchain:${this.jsonData.comchain.address}`
        //return `${this.backendId}/user/${this.jsonData.comchain.address}`
    }

    getSymbol () {
        return this.fromUserAccount.getSymbol()
    }

    private async getSplitting(amount: string, cmAccount, nantAccount, blockNb: "pending" | number) {
        let jsc3l = this.parent.jsc3l
        const cc = await this.fromUserAccount.getCurrencyMgr()
        const recipientAddress = this.jsonData.comchain.address

        // XXXvlab: these requests would be better if batched in some way, and if non-numeric
        // block nb, it won't risk receiving inconsistent data.
        let cmBal = await cmAccount.getBalance(blockNb)
        let nantBal = nantAccount ? await nantAccount.getBalance(blockNb) : "0.00"
        let cmLowLimit = await cmAccount.getLowLimit(blockNb)
        let cmReceiverHighLimit = await cc.bcRead.getCmLimitAbove(recipientAddress, blockNb)
        let cmReceiverBalance = await cc.bcRead.getCmBalance(recipientAddress, blockNb)


        let cmReceiverCanReceiveCents = strAmount2intCents(cmReceiverHighLimit) - strAmount2intCents(cmReceiverBalance)
        let split
        try {
            split = jsc3l.utils.getSplitting(
                strAmount2intCents(amount),
                {
                    cm: strAmount2intCents(cmBal),
                    nant: strAmount2intCents(nantBal)
                },
                strAmount2intCents(cmLowLimit),
                cmReceiverCanReceiveCents
            )
        } catch(err: any) {
            if (err instanceof jsc3l.utils.CmSpendLimitError) {
                throw new e.RecipientWouldHitCmHighLimit(
                    "Recipient can't receive as much mutual credits",
                    intCents2strAmount(strAmount2intCents(amount) - err.missingAmount)
                )
            }
            if (err instanceof jsc3l.utils.InsufficientBalanceError) {
                throw new e.PrepareTransferInsufficientBalance(
                    "Insufficient Balance",
                    intCents2strAmount(strAmount2intCents(amount) - err.missingAmount)
                )
            }
            console.error("Unexpected error while using jsc3l.utils.getSplitting")
            throw err
        }
        return {
            cm: intCents2strAmount(split.cm),
            nant: intCents2strAmount(split.nant),
        }
    }

    async prepareTransfer(
        amount: string,
        senderMemo: string,
        recipientMemo: string = senderMemo,
    ): Promise<t.ITransaction[]> {
        let moneyAccounts = await this.fromUserAccount.getAccounts()
        let nantAccount = moneyAccounts.find((acc) => acc.type === 'Nant')
        let cmAccount = moneyAccounts.find((acc) => acc.type === 'Cm')

        let realNantBal
        try {
            realNantBal = await nantAccount.getBalance("latest")
        } catch (err) {
            throw new e.PrepareTransferException("Collaterized getBalance latest failed", err)
        }
        let pendingNantBal
        try {
            pendingNantBal = await nantAccount.getBalance()
        } catch (err) {
            throw new e.PrepareTransferException("Collaterized getBalance pending failed", err)
        }

        // ensure realNantBal is the correct format
        if (
            !(realNantBal.includes(".") && realNantBal.split(".")[1].length === 2)
        ) {
            throw new e.PrepareTransferError(`Invalid amount returned by getBalance: ${realNantBal}`)
        }
        const amountCents = strAmount2intCents(amount)
        const realNantBalCents = strAmount2intCents(realNantBal)
        const pendingNantBalCents = strAmount2intCents(pendingNantBal)

        let transactions = []
        let destAddress = this.jsonData.comchain.address
        const safeWallet = this.parent.jsonData?.safe_wallet_recipient
        let split
        if (
            (safeWallet &&
                safeWallet.monujo_backends[this.backendId][0] === destAddress) ||
                !cmAccount
        ) {

            if (amountCents > pendingNantBalCents) {
                throw new e.PrepareTransferInsufficientBalance(
                    "Insufficient Balance",
                    intCents2strAmount(pendingNantBalCents)
                )
            }

            if (amountCents > realNantBalCents) {
                throw new e.PrepareTransferUnsafeBalance(
                    "Unsafe Balance due to pending transactions",
                    realNantBal
                )
            }

            split = { cm: 0, nant: amount }

        } else {
            // We'll need to check splitting rules
            let splitPending = await this.getSplitting(amount, cmAccount, nantAccount, "pending")
            const cc = await this.fromUserAccount.getCurrencyMgr()
            let currentBlockNb = await cc.ajaxReq.currBlock()
            let splitLatest
            try {
                splitLatest = await this.getSplitting(amount, cmAccount, nantAccount, currentBlockNb)
            } catch(err: any) {
                if (err instanceof e.RecipientWouldHitCmHighLimit || err instanceof e.PrepareTransferInsufficientBalance) {
                    throw new e.PrepareTransferUnsafeSplit(
                        "This splitting is unsafe due to pending operations",
                        err.safeAmount,
                        err,
                    )
                }
                console.error("Unexpected error while computing latest getSplitting", err)

                throw err
            }
            if (splitLatest.cm !== splitPending.cm || splitLatest.nant !== splitPending.nant) {
                throw new e.PrepareTransferUnsafeSplit(
                    "This splitting is unsafe due to pending operations",
                    0,
                    null
                )
            }
            split = splitPending
        }
        let jsc3l = this.parent.jsc3l
        let bcTransaction = jsc3l.bcTransaction
        if (split.cm > 0) {
            const currency = await cmAccount.getSymbol()
            let transferCm = bcTransaction.transferCM.bind(bcTransaction)
            let cmTx = new PlannedTransaction({
                amount: -split.cm,
                description: senderMemo,
                currency,
                related: this.name,
                tags: ["barter"],
                executeData: {
                    fn: this.transferFn.bind(this),
                    args: [
                        transferCm,
                        split.cm,
                        senderMemo,
                        recipientMemo,
                    ]
                }
            })
            transactions.push(cmTx)
        }
        if (split.nant > 0) {
            const currency = await nantAccount.getSymbol()
            let transferNant = bcTransaction.transferNant.bind(bcTransaction)
            let nantTx = new PlannedTransaction({
                amount: -split.nant,
                description: senderMemo,
                currency,
                related: this.name,
                tags: ["collateralized"],
                executeData: {
                    fn: this.transferFn.bind(this),
                    args: [
                        transferNant,
                        split.nant,
                        senderMemo,
                        recipientMemo,
                    ]
                }
            })
            transactions.push(nantTx)
        }
        return transactions

    }

    private async transferFn (
        fn: (
            clearWallet: any,
            destAddress: string,
            amount: number,
            data: any,
        ) => any,
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
            jsonData = await fn(clearWallet, destAddress, amount, data)
        } catch (err) {
            if (err instanceof APIError) {
                if (err.message === 'Incompatible_Amount') {
                    if (err.data === 'InsufficientNantBalance') {
                        throw new e.InsufficientBalance(
                            'Insufficient fund to afford transfer',
                        )
                    }
                    throw new e.RefusedAmount(
                        `Amount refused by backend (given reason: ${err.data})`,
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
                'Unexpected response to transferFn (not a transaction id): ',
                jsonData,
            )
            throw new Error('Transaction ID has invalid format')
        }

        let transactionInfo: t.JsonData
        let totalTime = 0
        while (true) {
            try {
                transactionInfo = await jsc3l.ajaxReq.getTransactionInfo(
                    jsonData,
                )
                break
            } catch (err) {
                totalTime += 500
                if (totalTime >= 10000) {
                    console.error('Timeout or Confirmation Missing', err)
                    throw new e.PaymentConfirmationMissing(
                        "Couldn't get information on last accepted transaction within 10 seconds.",
                    )
                }
                await new Promise((resolve) => setTimeout(resolve, 500))
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
        const [type, limitMin, limitMax] = [0, 0, 1000]
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
                limitMax,
                limitMin,
            )
            try {
                queryUntil(
                    () =>
                        this.parent.jsc3l.bcRead.getAccountStatus(destAddress),
                    (res) => res === 1,
                )
            } catch (err) {
                if (err instanceof e.TimeoutError) {
                    console.log(
                        'Transaction did not change account status in the expected time frame.',
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
                },
            },
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

    public async isBusinessForFinanceBackend () {
        const type = await this.parent.jsc3l.bcRead.getAccountType(this.jsonData.comchain.address)
        return type === 1
    }
}
