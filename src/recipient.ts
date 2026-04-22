import { t, e } from '@lokavaluto/lokapi'
import Recipient from '@lokavaluto/lokapi/build/backend/odoo/recipient'
import { PlannedTransaction } from '@lokavaluto/lokapi/build/backend/odoo/transaction'

import { APIError } from '@com-chain/jsc3l/build/exception'

import { ComchainTransaction } from './transaction'
import { intCents2strAmount, strAmount2intCents } from './helpers'
import { ttlcache, singleton } from './cache'


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

    @ttlcache({
        ttl: (x: any) => x.args.blockNb === "pending" ? 3 : 3600,
        key: ({instance, args: [amount, cmAccount, nantAccount, blockNb, signal]}) => [
            amount, cmAccount.internalId, nantAccount ? nantAccount.internalId : "", blockNb,
        ],
        cacheOnSettled: true
    })
    private async getSplitting(amount: string, cmAccount, nantAccount, blockNb: "pending" | number, signal: AbortSignal) {

        signal.throwIfAborted()
        let jsc3l = this.parent.jsc3l
        const cc = await this.fromUserAccount.getCurrencyMgr()
        const recipientAddress = this.jsonData.comchain.address

        const [cmBal, nantBal, cmLowLimit, cmReceiverHighLimit, cmReceiverBalance] = await Promise.all([
            cmAccount.getBalance(blockNb),
            nantAccount ? nantAccount.getBalance(blockNb) : "0.00",
            cmAccount.getLowLimit(blockNb),
            cc.bcRead.getCmLimitAbove(recipientAddress, blockNb),
            cc.bcRead.getCmBalance(recipientAddress, blockNb)
        ])
        signal.throwIfAborted()

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

    @ttlcache({
        ttl: 5,
        key: ({instance, args: [amount, signal]}) => amount,
        cacheOnSettled: true
    })
    async _prepareSplitting(amount: string, signal: AbortSignal) {
        let moneyAccounts = await this.fromUserAccount.getAccounts()
        let nantAccount = moneyAccounts.find((acc) => acc.type === 'Nant')
        let cmAccount = moneyAccounts.find((acc) => acc.type === 'Cm')

        let destAddress = this.jsonData.comchain.address
        const safeWallet = this.parent.jsonData?.safe_wallet_recipient
        let split
        if (
            (nantAccount && safeWallet &&
                safeWallet.monujo_backends[this.backendId][0] === destAddress) ||
                !cmAccount
        ) {
            const [ realNantBal, pendingNantBal, nantSymbol ] = await Promise.all([
                async function () {
                    try {
                        return await nantAccount.getBalance("latest")
                    } catch (err) {
                        throw new e.PrepareTransferException("Collaterized getBalance latest failed", err)
                    }
                }(),
                async function () {
                    try {
                        return await nantAccount.getBalance("pending")
                    } catch (err) {
                        throw new e.PrepareTransferException("Collaterized getBalance pending failed", err)
                    }
                }(),
                nantAccount.getSymbol()
            ])
            signal.throwIfAborted()

            // ensure realNantBal is the correct format
            if (
                !(realNantBal.includes(".") && realNantBal.split(".")[1].length === 2)
            ) {
                throw new e.PrepareTransferError(`Invalid amount returned by getBalance: ${realNantBal}`)
            }

            const amountCents = strAmount2intCents(amount)
            const realNantBalCents = strAmount2intCents(realNantBal)
            const pendingNantBalCents = strAmount2intCents(pendingNantBal)

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

            return {
                split:{ cm: "0.00", nant: amount },
                symbol: {nant: nantSymbol}
            }

        }
        // We'll need to check splitting rules
        const self = this
        const cc = await this.fromUserAccount.getCurrencyMgr()
        const currentBlockNb = await cc.ajaxReq.currBlock()
        const [ splitPending, splitLatest, cmSymbol, nantSymbol] = await Promise.all([
            this.getSplitting(amount, cmAccount, nantAccount, "pending", signal),
            async function () {
                let splitLatest
                try {
                    splitLatest = await self.getSplitting(
                        amount, cmAccount, nantAccount, currentBlockNb, signal
                    )
                } catch(err: any) {
                    if (signal.aborted) throw err
                    if (err instanceof DOMException) {
                        console.warn(`Recipient: Signal was not aborted but we got the exception`)
                        throw err
                    }

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
                return splitLatest
            }(),
            cmAccount.getSymbol(),
            nantAccount ? nantAccount.getSymbol() : null,
        ])

        if (splitLatest.cm !== splitPending.cm || splitLatest.nant !== splitPending.nant) {
            throw new e.PrepareTransferUnsafeSplit(
                "This splitting is unsafe due to pending operations",
                0,
                null
            )
        }
        return {
            split: splitPending,
            symbol: {nant: nantSymbol, cm: cmSymbol}
        }
    }

    /**
     * Convert comchain-flavored account data to the format expected
     * by the administrative backend (Odoo) and forward via
     * ``POST /wallet/<ident>/update``.
     *
     * Conversions applied before forwarding:
     *   - ``accountType``: label string → integer
     *   - ``status``: boolean → ``"active"`` / ``"disabled"``
     *
     * Only provided fields are included in the payload; omitted
     * fields are left unchanged on the admin side.
     */
    async updateAccountForAdministrativeBackend(accountData: {
        status?: boolean,
        accountType?: string,
        lowLimit?: string,
        highLimit?: string,
    }) {
        const converted: Record<string, string | number> = {}
        if (accountData.accountType !== undefined) {
            const accountTypeInt = this.parent.accountTypeToInt[accountData.accountType]
            if (accountTypeInt === undefined) {
                throw new Error(`Invalid account type: ${accountData.accountType}`)
            }
            converted.accountType = accountTypeInt
        }
        if (accountData.status !== undefined) {
            converted.status = accountData.status ? "active" : "disabled"
        }
        if (accountData.lowLimit !== undefined) {
            converted.lowLimit = accountData.lowLimit
        }
        if (accountData.highLimit !== undefined) {
            converted.highLimit = accountData.highLimit
        }
        return super.updateAccountForAdministrativeBackend(converted)
    }

    /**
     * Apply account parameter changes on the comchain blockchain.
     *
     * Accepts partial data: only the fields present in
     * ``accountData`` are treated as updates. Missing fields are
     * fetched from the blockchain so that ``setAccountParam`` always
     * receives a complete parameter set. Only missing fields
     * trigger an RPC read, keeping blockchain calls to a minimum.
     *
     * Conversions applied to caller-provided values:
     *   - ``accountType``: label string → integer
     *   - ``status``: boolean → ``1`` / ``0``
     *
     * After the transaction is submitted, polls until the
     * transaction is mined (blockHash present) or a 10 s timeout
     * is reached.
     */
    async updateAccountForFinancialBackend(accountData: {
        status?: boolean,
        accountType?: string,
        lowLimit?: string,
        highLimit?: string,
    }) {
        const { status, accountType, lowLimit, highLimit } = accountData
        const jsc3l = this.parent.jsc3l
        const address = this.jsonData.comchain.address
        const cc = await this.fromUserAccount.getCurrencyMgr()

        if (accountType !== undefined &&
            this.parent.accountTypeToInt[accountType] === undefined) {
            throw new Error(`Invalid account type: ${accountType}`)
        }

        // For each param: use the caller's value (converted) or fetch
        // from blockchain. Only missing fields trigger an RPC call.
        const [accountTypeInt, statusInt, resolvedLowLimit, resolvedHighLimit]:
            [number, number, string, string] = await Promise.all([
                accountType !== undefined
                    ? this.parent.accountTypeToInt[accountType]
                    : cc.bcRead.getAccountType(address),
                status !== undefined
                    ? (status ? 1 : 0)
                    : cc.bcRead.getAccountStatus(address),
                lowLimit ?? cc.bcRead.getCmLimitBelow(address),
                highLimit ?? cc.bcRead.getCmLimitAbove(address),
            ])

        const clearWallet = await this.backends.comchain.unlockWallet()

        const jsonData = await jsc3l.bcTransaction.setAccountParam(
            clearWallet, address,
            statusInt, accountTypeInt, resolvedHighLimit, resolvedLowLimit,
        )

        if (!/^0x[a-fA-F0-9]{64}$/.test(jsonData.toString())) {
            console.error(
                'Unexpected response to setAccountParam (not a transaction id): ',
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
            } catch (err) {
                totalTime += 500
                if (totalTime >= 10000) {
                    console.error('Timeout or Confirmation Missing', err)
                    throw new e.PaymentConfirmationMissing(
                        "Couldn't get information on last accepted transaction within 10 seconds.",
                    )
                }
                await new Promise((resolve) => setTimeout(resolve, 500))
                continue
            }
            if ((transactionInfo.transaction as any)?.blockHash) break
            await new Promise((resolve) => setTimeout(resolve, 500))
        }

        return transactionInfo.transaction
    }

    async prepareTransfer(
        amount: string,
        senderMemo: string,
        recipientMemo: string = senderMemo,
        signal: AbortSignal,
    ): Promise<t.ITransaction[]> {

        let transactions = []

        signal.throwIfAborted()

        const {split, symbol} = await this._prepareSplitting(amount, signal)

        signal.throwIfAborted()

        const jsc3l = this.parent.jsc3l
        const bcTransaction = jsc3l.bcTransaction
        if (strAmount2intCents(split.cm) > 0) {
            const transferCm = bcTransaction.transferCM.bind(bcTransaction)
            const cmTx = new PlannedTransaction({
                amount: -split.cm,
                description: senderMemo,
                currency: symbol.cm,
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
        if (strAmount2intCents(split.nant) > 0) {
            const transferNant = bcTransaction.transferNant.bind(bcTransaction)
            const nantTx = new PlannedTransaction({
                amount: -split.nant,
                description: senderMemo,
                currency: symbol.nant,
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

    public async preparePledge(amount: number, senderMemo: string) {
        const jsc3l = this.parent.jsc3l
        const bcTransaction = jsc3l.bcTransaction
        const pledgeFn = bcTransaction.pledgeAccount.bind(bcTransaction)

        const moneyAccounts = await this.fromUserAccount.getAccounts()
        const nantAccount = moneyAccounts.find((acc) => acc.type === 'Nant')

        return [
            new PlannedTransaction(
                {
                    amount,
                    description: senderMemo,
                    currency: nantAccount.getSymbol(),
                    related: "Admin",
                    tags: ["collateralized"],
                    executeData: {
                        fn: this.transferFn.bind(this),
                        args: [
                            pledgeFn,
                            amount,
                            senderMemo,
                            null
                        ]
                    }
                }
            )
        ]
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
        recipientMemo: string | null = senderMemo,
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
            } catch (err) {
                totalTime += 500
                if (totalTime >= 10000) {
                    console.error('Timeout or Confirmation Missing', err)
                    throw new e.PaymentConfirmationMissing(
                        "Couldn't get information on last accepted transaction within 10 seconds.",
                    )
                }
                await new Promise((resolve) => setTimeout(resolve, 500))
                continue
            }

            if (transactionInfo.add1)
                break
            await new Promise((resolve) => setTimeout(resolve, 500))
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

    /**
     * Validate the creation of this recipient's comchain account by
     * activating it on both the financial backend (on-chain) and
     * the administrative backend (Odoo).
     *
     * comchain-only
     *
     * Requires the caller to hold user-account validation rights
     * (typically an admin); throws ``PermissionDenied`` otherwise.
     *
     * The on-chain status is read first and
     * ``updateAccountForFinancialBackend({ status: true })`` is
     * only invoked when the account is not already active, avoiding
     * a redundant blockchain transaction. The administrative
     * backend is then notified via
     * ``updateAccountForAdministrativeBackend({ status: true })``
     * to mirror the active state.
     */
    public async validateCreation () {
        if (!(await this.parent.hasUserAccountValidationRights())) {
            throw new e.PermissionDenied(
                'You need to be admin to validate creation of wallet',
            )
        }
        const address = this.jsonData.comchain.address
        const cc = await this.fromUserAccount.getCurrencyMgr()
        const status = await cc.bcRead.getAccountStatus(address)
        if (status !== 1) {
            await this.updateAccountForFinancialBackend({ status: true })
        }
        await this.updateAccountForAdministrativeBackend({ status: true })
    }

    get internalId () {
        return `${this.parent.uri}/${this.jsonData.comchain.address}`
    }

    get ident () {
        return this.jsonData.comchain.address
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

    @ttlcache({ttl: 15})
    public async isBusinessForFinanceBackend () {
        const type = await this.parent.jsc3l.bcRead.getAccountType(this.jsonData.comchain.address)
        return type === 1
    }


    /**
     * Returns the target account's type label by reading from the
     * blockchain and mapping the int value to a label.
     */
    private async getTargetAccountTypeLabel (): Promise<string> {
        const typeInt = await this.parent.jsc3l.bcRead.getAccountType(
            this.jsonData.comchain.address
        )
        for (const [label, value] of Object.entries(
            this.parent.accountTypeToInt
        )) {
            if (value === typeInt) {
                return label
            }
        }
        return 'unknown'
    }


    /**
     * Returns per-field edit capabilities for inspecting this
     * recipient's account.
     *
     * Combines:
     *   - Contract version restrictions (old vs v2)
     *   - Target account's current type (admin accounts have limits locked)
     *   - Caller's permissions (can they manage this account type?)
     */
    public async getAccountEditCapabilities (): Promise<{
        accountType: { editable: boolean, warnings: string[] },
        limits: { editable: boolean },
        status: { editable: boolean },
    }> {
        const callerAccounts = Object.values(this.parent.userAccounts) as any[]
        const callerIsActive = callerAccounts.some(
            (a: any) => a.active
        )

        if (!callerIsActive) {
            return {
                accountType: { editable: false, warnings: [] },
                limits: { editable: false },
                status: { editable: false },
            }
        }

        const [version, targetType, editableTypes] = await Promise.all([
            this.parent.getContractVersion(),
            this.getTargetAccountTypeLabel(),
            this.fromUserAccount.getEditableAccountTypeLabels(),
        ])
        const isAdmin = targetType === 'admin'
        const canManageThisType = editableTypes.includes(targetType)
        const callerHasSetAdmin = editableTypes.includes('admin')

        if (!version) {
            // Old contract: admin accounts are fully locked
            return {
                accountType: {
                    editable: !isAdmin && canManageThisType,
                    warnings: isAdmin ? [] : ['set-admin-irreversible'],
                },
                limits: { editable: !isAdmin },
                status: { editable: callerHasSetAdmin || (!isAdmin && canManageThisType) },
            }
        }
        const currencyMgr = await this.fromUserAccount.getCurrencyMgr()
        const hasCm = currencyMgr.customization.hasCM()

        // v2.0+: admin type is changeable, limits remain locked
        // Admin callers can manage other admins' type and status
        return {
            accountType: {
                editable: canManageThisType,
                warnings: [
                    ...hasCm ? ['set-admin-locks-limits'] : []
                ],
            },
            limits: { editable: !isAdmin },
            status: { editable: canManageThisType },
        }
    }


    /**
     * Archive this recipient on the administrative backend, after
     * ensuring its comchain account is disabled on-chain.
     *
     * The administrative backend's archive flow assumes the
     * underlying wallet has already been disabled on the financial
     * backend. This override enforces that invariant: the
     * on-chain status is read first, and ``super.archive()`` is
     * only called once the account is disabled (``status === 0``).
     *
     * When the account is still active, ``updateAccountForFinancialBackend``
     * is invoked to disable it and the on-chain status is re-read.
     * The loop is retried up to three times to absorb transient
     * propagation delays between transaction submission and the
     * status becoming visible on-chain; an ``Error`` is thrown if
     * the account is still active after the final attempt.
     */
    public async archive (): Promise<boolean> {
        const address = this.jsonData.comchain.address
        const cc = await this.fromUserAccount.getCurrencyMgr()
        let currentStatus = await cc.bcRead.getAccountStatus(address)

        for (let attempt = 0; attempt < 3; attempt++) {
            if (currentStatus === 0) {
                return super.archive()
            }

            await this.updateAccountForFinancialBackend({ status: false })
            currentStatus = await cc.bcRead.getAccountStatus(address)
        }

        throw new Error(
            'Failed to disable account on the financial backend after 3 attempts'
        )
    }
}
