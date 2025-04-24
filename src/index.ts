import Jsc3lAbstract from '@com-chain/jsc3l'
import * as Jsc3lException from '@com-chain/jsc3l/build/exception'

import { t, e } from '@lokavaluto/lokapi'
import { mux } from '@lokavaluto/lokapi/build/generator'
import { makePasswordChecker } from '@lokavaluto/lokapi/build/backend/utils'
import { BackendAbstract } from '@lokavaluto/lokapi/build/backend'
import UserAccount from '@lokavaluto/lokapi/build/backend/odoo/userAccount'
import { e as httpRequestExc } from '@0k/types-request'

import { ComchainAccount } from './account'
import { ComchainRecipient } from './recipient'
import { ComchainTransaction, isReconversion } from './transaction'
import { ComchainCreditRequest } from './creditRequest'
import { intCents2strAmount, strAmount2intCents } from './helpers'


interface IJsonDataWithAddress extends t.JsonData {
    address: string
}

export default abstract class ComchainBackendAbstract extends BackendAbstract {

    splitMemoSupport = true

    _jsc3l: Jsc3lAbstract

    get jsc3l () {
        if (!this._jsc3l) {
            const { httpRequest, persistentStore } = this
            class Jsc3l extends Jsc3lAbstract {
                persistentStore = persistentStore
                httpRequest = async (opts) => {
                    if (opts.method === 'POST') {
                        opts.headers = opts.header || {}
                        opts.headers['Content-Type'] =
                            'application/x-www-form-urlencoded'
                    }
                    const data = await httpRequest(opts)
                    try {
                        return JSON.parse(<string>data)
                    } catch (e) {
                        return data
                    }
                }
            }
            this._jsc3l = new Jsc3l()
        }
        return this._jsc3l
    }

    private getSubBackend (
        jsc3l: Jsc3lAbstract,
        jsonData: IJsonDataWithAddress
    ) {
        return new ComchainUserAccount(
            {
                comchain: jsc3l,
                ...this.backends,
            },
            this,
            jsonData
        )
    }

    public get userAccounts () {
        if (!this._userAccounts) {
            this._userAccounts = {}
            this.jsonData.accounts.forEach(
                (bankAccountData: IJsonDataWithAddress) => {
                    const comchainUserAccount = this.getSubBackend(
                        this.jsc3l,
                        bankAccountData
                    )
                    this._userAccounts[
                        comchainUserAccount.internalId
                    ] = comchainUserAccount
                }
            )
        }
        return this._userAccounts
    }

    private _userAccounts: any

    public async getAccounts (): Promise<any> {
        const backendBankAccounts = []
        for (const id in this.userAccounts) {
            const userAccount = this.userAccounts[id]
            const bankAccounts = await userAccount.getAccounts()
            bankAccounts.forEach((bankAccount: any) => {
                backendBankAccounts.push(bankAccount)
            })
        }
        return backendBankAccounts
    }


    public makeRecipients (jsonData: t.JsonData): t.IRecipient[] {
        const recipients = []
        if (Object.keys(this.userAccounts).length === 0) {
            throw new Error(
                'Current user has no account in comchain. Unsupported yet.'
            )
        }
        if (Object.keys(this.userAccounts).length > 1) {
            // We will need to select one of the source userAccount of the
            // current logged in user
            throw new Error(
                'Current user has more than one account in comchain. ' +
                    'Unsupported yet.'
            )
        }
        if (Object.keys(jsonData.monujo_backends).length === 0) {
            throw new Error(
                'Target recipient has no account in comchain.'
            )
        }
        jsonData.monujo_backends[this.internalId].forEach((address: string) => {
            recipients.push(
                new ComchainRecipient(
                    {
                        comchain: Object.values(this.userAccounts)[0],
                        ...this.backends,
                    },
                    this,
                    {
                        odoo: jsonData,
                        comchain: { address },
                    }
                )
            )
        })
        return recipients
    }

    public makeCreditRequest (jsonData: t.JsonData): Promise<t.ICreditRequest> {
        const creditRequests = []
        if (Object.keys(this.userAccounts).length === 0) {
            throw new Error(
                'Current user has no account in comchain. Unsupported yet.'
            )
        }
        if (Object.keys(this.userAccounts).length > 1) {
            // We will need to select one of the source userAccount of the
            // current logged in user
            throw new Error(
                'Current user has more than one account in comchain. ' +
                    'Unsupported yet.'
            )
        }

        const userAccount = Object.values(
            this.userAccounts
        )[0] as ComchainUserAccount
        return userAccount.makeCreditRequest(jsonData)
    }

    public async * getTransactions (opts: any): AsyncGenerator {
        yield * ComchainTransaction.mux(
            Object.values(this.userAccounts).map((u: ComchainUserAccount) =>
                u.getTransactions(opts)
            ),
            opts?.order || ['-date']
        )
    }

    isPasswordStrongEnoughSync = makePasswordChecker([
        'tooShort:8',
        'noUpperCase',
        'noLowerCase',
        'noDigit',
        // "noSymbol",
    ])

    public async isPasswordStrongEnough (
        password: string
    ): Promise<Array<string>> {
        return this.isPasswordStrongEnoughSync(password)
    }

    private async _registerWallet (
        cipheredWallet: t.JsonData,
        messageKey: string,
        active: boolean
    ) {

        const res = await this.backends.odoo.$post('/comchain/register', {
            address: cipheredWallet.address,
            wallet: JSON.stringify(cipheredWallet),
            message_key: messageKey,
            active,
        })
        if (res.error) {
            console.error(`Failed to create user account: ${res.error}`)
            if (res.error === 'account already exists') {
                throw new e.UserAccountAlreadyExists(res.error)
            }
            throw new Error(res.error)
        }
        if (typeof cipheredWallet.address !== 'string') {
            throw new Error("Unexpected type for 'address' in ciphered wallet")
        }
        return this.getSubBackend(this.jsc3l, {
            active,
            address: cipheredWallet.address,
            wallet: cipheredWallet,
            message_key: messageKey,
        })
    }

    public async registerWallet (cipheredWallet): Promise<ComchainUserAccount> {
        const currencyMgr = await this.jsc3l.getCurrencyMgr(
            this.jsonData.type.split(':')[1]
        )
        const userAccount = this.getSubBackend(this.jsc3l, {
            active: false,
            address: cipheredWallet.address,
            wallet: cipheredWallet,
            message_key: null,
        })

        const wallet = await userAccount.unlockWallet()
        await wallet.ensureWalletMessageKey()
        const active = await userAccount.isActiveAccount()
        const messageKey = wallet.messageKeysFromWallet()
        return await this._registerWallet(cipheredWallet, messageKey, active)
    }

    public async createUserAccount ({
        password,
    }): Promise<ComchainUserAccount> {
        const currencyMgr = await this.jsc3l.getCurrencyMgr(
            this.jsonData.type.split(':')[1]
        )
        const wallet = await currencyMgr.wallet.createWallet()
        const cipheredWallet = wallet.encryptWallet(password)
        const messageKey = wallet.messageKeysFromWallet()

        return await this._registerWallet(cipheredWallet, messageKey, false)

    }

}


export class ComchainUserAccount extends UserAccount {

    address: string

    constructor (backends, parent, jsonData) {
        super(backends, parent, jsonData)
        this.address = jsonData.wallet.address
    }

    public get active () {
        return this.jsonData.active
    }

    public async getSymbol () {
        const currencyMgr = await this.getCurrencyMgr()
        let currencies = currencyMgr.customization.getCurrencies()
        return currencies.CUR
    }

    public async getCurrencyName () {
        const currencyMgr = await this.getCurrencyMgr()
        let currencies = currencyMgr.customization.getCurrencies()
        return currencies.CUR_global
    }

    _errorsCache = new Map<Error, Error>
    private async getCurrencyMgr () {
        if (!this._currencyMgrPromise) {
            // This will trigger the discovery of master servers and load
            // the server conf of the currency.
            this._currencyMgrPromise = this.backends.comchain.getCurrencyMgr(
                this.jsonData.wallet.server.name
            )
        }
        try {
            return await this._currencyMgrPromise
        } catch(err: any) {
            this._currencyMgrPromise = null
            if (err instanceof Jsc3lException.NoEndpointAvailable) {
                if (!this._errorsCache.has(err)) {
                    this._errorsCache.set(
                        err,
                        new e.BackendUnavailableTransient(
                            "Comchain backend is unavailable due to lack of available endpoint"
                        )
                    )
                }
                throw this._errorsCache.get(err)
            }
            throw err
        }
    }

    _currencyMgrPromise: { [index: string]: any }


    /**
     * getBalance on the User Account sums all the balances of user
     * accounts
     */
    public async getBalance (blockNb: string | number = 'pending'): Promise<string> {
        const bankAccounts = await this.getAccounts()
        const balances = await Promise.all(
            bankAccounts.map((bankAccount: any) => bankAccount.getBalance(blockNb))
        )
        return intCents2strAmount(balances
                .map((a: string) => strAmount2intCents(a))
            .reduce((s: bigint, a: bigint) => s + a, 0n)
        )
    }


    /**
     * getPendingTopUp on the User Account gets pending top ups in the
     * only creditable bank account
     */
    public async getPendingTopUp (): Promise<Array<any>> {
        const bankAccounts = await this.getAccounts()
        const creditableAccounts = bankAccounts.filter(
            (bankAccount) => bankAccount.creditable
        )
        if (creditableAccounts.length > 1) {
            throw new Error(
                'Unsupported retrieval of pending top ups on multiple ' +
                    'creditable sub-accounts'
            )
        }
        if (creditableAccounts.length === 0) {
            return []
        }
        return await creditableAccounts[0].getPendingTopUp()
    }

    private _type: number
    private async getType () {
        if (!this._type) {
            const currencyMgr = await this.getCurrencyMgr()
            this._type = await currencyMgr.bcRead.getAccountType(this.address)
        }
        return this._type
    }


    private _status: number
    private async getStatus () {
        if (!this._status) {
            const currencyMgr = await this.getCurrencyMgr()
            this._status = await currencyMgr.bcRead.getAccountStatus(
                this.address
            )
        }
        return this._status
    }


    public async hasUserAccountValidationRights () {
        let accountType = await this.getType()
        return accountType == 2 || accountType == 4
    }


    public async hasCreditRequestValidationRights () {
        let accountType = await this.getType()
        return accountType == 2 || accountType == 3
    }

    public async isBusinessForFinanceBackend () {
        return (await this.getType()) == 1
    }

    public async isActiveAccount () {
        return (await this.getStatus()) == 1
    }

    public async requiresUnlock () {
        return true
    }

    /**
     * Use `requestLocalPassword` that is provided by the GUI to
     * return the decrypted wallet. You can override this global setting
     * by providing an async function as first argument.
     */
    public async unlockWallet (requestCredentialsFromUserFn?: any) {
        let [_password, wallet] = await this._unlockWallet(
            requestCredentialsFromUserFn
        )
        return wallet
    }

    /**
     * Use `requestLocalPassword` that is provided by the GUI to
     * return the decrypted wallet. You can override this global setting
     * by providing an async function as first argument.
     */
    public async requestCredentials (requestCredentialsFromUserFn?: any) {
        let [password, _wallet] = await this._unlockWallet(
            requestCredentialsFromUserFn
        )
        return password
    }

    /**
     * Use `requestLocalPassword` that is provided by the GUI to
     * return the decrypted wallet. You can override this global setting
     * by providing an async function as first argument.
     */
    private async _unlockWallet (requestCredentialsFromUserFn?: any) {
        let password
        let state = 'firstTry'
        requestCredentialsFromUserFn =
            requestCredentialsFromUserFn || this.parent.requestLocalPassword
        while (true) {
            password = await requestCredentialsFromUserFn(state, this)
            try {
                return [
                    password,
                    this.backends.comchain.wallet.getWalletFromPrivKeyFile(
                        JSON.stringify(this.jsonData.wallet),
                        password
                    ),
                ]
            } catch (e) {
                state = 'failedUnlock'
                console.log('Failed to unlock wallet', e)
            }
        }
    }


    /**
     * In the current implementation, a user is identified by its wallet, and as
     * such, it is also having only one account.
     *
     */
    async getAccounts () {
        if (!this.active) return []

        const accounts = []
        const currencyMgr = await this.getCurrencyMgr()
        if (currencyMgr.customization.hasNant()) {
            accounts.push(
                new ComchainAccount(
                    { comchain: currencyMgr, ...this.backends },
                    this,
                    {
                        comchain: {
                            address: this.jsonData.address,
                            type: 'Nant',
                        },
                    }
                )
            )
        }
        if (currencyMgr.customization.hasCM()) {
            accounts.push(
                new ComchainAccount(
                    { comchain: this, ...this.backends },
                    this,
                    {
                        comchain: { type: 'Cm' },
                    }
                )
            )
        }
        return accounts
    }

    get internalId () {
        return `comchain:${this.address}`
    }

    public async * getTransactions (opts: any): AsyncGenerator {
        if (!this.active) return

        let dateBoundaries = false
        switch (
            [opts?.dateBegin, opts?.dateEnd]
                .map((x) => (x ? '1' : '0'))
                .join('')
        ) {
            case '10':
            case '01':
                throw new Error('Unsupported partial date boundaries')
            case '11':
                dateBoundaries = true
                break
        }

        const backend = this.parent
        const currencyMgr = await this.getCurrencyMgr()
        const addressResolve = {}
        const reconversionStatusResolve = {}
        const limit = 30
        let offset = 0
        while (true) {
            let transactionsData = await (dateBoundaries
                ? currencyMgr.ajaxReq.getExportTransList(
                      `0x${this.address}`,
                      Math.round(opts.dateBegin.getTime() / 1000),
                      Math.round(opts.dateEnd.getTime() / 1000)
                  )
                : currencyMgr.ajaxReq.getTransList(
                      `0x${this.address}`,
                      limit,
                      offset
                  ))
            const uniqueAddresses = transactionsData
                .map((t: any) => t[t.direction === 2 ? 'addr_from' : 'addr_to'])
                .filter(
                    (t: any, idx: number, self) =>
                        self.indexOf(t) === idx &&
                        typeof addressResolve[t] === 'undefined' &&
                        t !== 'Admin'
                )
                .map((t: any) => t.substring(2))
            if (uniqueAddresses.length > 0) {
                const contacts = await this.backends.odoo.$post(
                    '/comchain/contact',
                    {
                        addresses: uniqueAddresses,
                    }
                )
                for (const k in contacts) {
                    addressResolve[k] = contacts[k]
                }
            }
            // XXXvlab: will need to change all internalId's to match new
            // format
            const backendInternalId = backend.internalId.replace(":", "://")
            const uniqueReconversionAddresses = transactionsData
                .filter((txData: any) => isReconversion(txData, backend))
                .map((txData:any) => `${backendInternalId}/tx/${txData.hash}`)
                .filter((txId: any, idx, self) => self.indexOf(txId) === idx &&
                    typeof reconversionStatusResolve[txId] === 'undefined')

            if (uniqueReconversionAddresses.length > 0) {
                let reconversions
                try {
                    reconversions = await this.backends.odoo.$post(
                        '/partner/reconversions',
                        {
                            transactions: uniqueReconversionAddresses,
                        }
                    )
                } catch (err) {
                    if (err instanceof httpRequestExc.HttpError && err.code === 404) {
                        // Remain compatible if API point doesn't exist
                        reconversions = {}
                    } else {
                        throw err
                    }
                }
                for (const t in reconversions) {
                    reconversionStatusResolve[t] = reconversions[t]
                }
            }
            for (let idx = 0; idx < transactionsData.length; idx++) {
                const transactionData = transactionsData[idx]
                if (transactionData.addr_to === `0x${this.address}`) {
                    yield new ComchainTransaction(
                        {
                            ...this.backends,
                            ...{ comchain: currencyMgr },
                        },
                        this,
                        {
                            comchain: Object.assign({}, transactionData, {
                                amount: transactionData.recieved,
                            }),
                            odoo: {addressResolve, reconversionStatusResolve}
                        }
                    )
                }
                if (transactionData.addr_from === `0x${this.address}`) {
                    yield new ComchainTransaction(
                        {
                            ...this.backends,
                            ...{ comchain: currencyMgr },
                        },
                        this,
                        {
                            comchain: Object.assign({}, transactionData, {
                                amount: -transactionData.sent,
                            }),
                            odoo: {addressResolve, reconversionStatusResolve}
                        }
                    )
                }
            }
            if (dateBoundaries) break
            if (transactionsData.length < limit) {
                return
            }
            offset += limit
        }
    }

    public async makeCreditRequest (
        jsonData: t.JsonData
    ): Promise<t.ICreditRequest> {
        const currencyMgr = await this.getCurrencyMgr()
        return new ComchainCreditRequest(
            {
                comchain: currencyMgr,
                ...this.backends,
            },
            this,
            {
                odoo: jsonData,
                comchain: { address: jsonData.monujo_backend[1] },
            }
        )
    }

}
