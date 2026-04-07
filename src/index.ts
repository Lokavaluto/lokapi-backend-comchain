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
import { ttlcache, singleton } from './cache'

interface IJsonDataWithAddress extends t.JsonData {
    address: string
}

export default abstract class ComchainBackendAbstract extends BackendAbstract {

    splitMemoSupport = true

    accountTypeToInt = {
        personal: 0,
        professional: 1,
        admin: 2,
        pledgeAdmin: 3,
        propertyAdmin: 4,
    }

    public getAccountTypeLabels (): string[] {
        return Object.keys(this.accountTypeToInt)
    }

    @singleton
    get jsc3l () {
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
        return new Jsc3l()
    }

    @singleton({key: (x) => x.args[1]})
    private getSubBackend (
        jsc3l: Jsc3lAbstract,
        jsonData: t.JsonData,
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

    public getCurrencyName () {
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

        return this.userAccounts[0].getCurrencyName()
    }

    @singleton({key: (x) => x.instance.jsonData.accounts})
    public get userAccounts () {
        return Object.fromEntries(
            this.jsonData.accounts.map(
                (bankAccountData: IJsonDataWithAddress) => {
                    const comchainUserAccount = this.getSubBackend(
                        this.jsc3l,
                        bankAccountData
                    )
                    return [comchainUserAccount.internalId,
                            comchainUserAccount]
                }
            )
        )
    }

    async isUnconfigured() {
        const accounts = await this.getAccounts()
        return accounts.length === 0
    }

    public getUserAccountsFromWalletIdent (currencyIdent: string, walletIdent: string): ComchainUserAccount {
        return this.getSubBackend(this.jsc3l, {
            active: true,
            wallet: {
                address: `${walletIdent}`,
                server: { name: currencyIdent },
            },
        })
    }

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

    @singleton
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
            const walletCurrency = (cipheredWallet as any)?.server?.name
            if (walletCurrency && res.error.includes(walletCurrency) && res.error.includes('not found')) {
                throw new e.CurrencyNotAvailable(walletCurrency, res.error)
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
        const backendCurrency = this.jsonData.type.split(':')[1]
        const walletCurrency = (cipheredWallet as any)?.server?.name
        if (walletCurrency && walletCurrency !== backendCurrency) {
            throw new e.CurrencyMismatch(walletCurrency)
        }
        const currencyMgr = await this.jsc3l.getCurrencyMgr(backendCurrency)
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

    @ttlcache({ttl: 300})
    public get technicalAccountAddrs () {

        // Administrative backend's safe wallet

        const technicalAccounts = []
        const safeWalletRecipient = this.jsonData?.safe_wallet_recipient
        if (safeWalletRecipient) {
            const safeWalletAddrs = safeWalletRecipient.monujo_backends[this.internalId]
            for (const safeWalletAddr of safeWalletAddrs) {
                technicalAccounts.push('0x' + safeWalletAddr)
            }
        }

        // Currency configuration's technical accounts

        const technicalAccountAddrs = this.jsc3l.customization.cfg.server.technicalAccounts || []
        for (const technicalAccountAddr of technicalAccountAddrs) {
            technicalAccounts.push(technicalAccountAddr)
        }
        return technicalAccounts
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
    @singleton
    private async getCurrencyMgr () {
        try {
            // This will trigger the discovery of master servers and load
            // the server conf of the currency.
            return await this.backends.comchain.getCurrencyMgr(
                this.jsonData.wallet.server.name
            )
        } catch(err: any) {
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

    @ttlcache({ttl: 5})
    public async getType () {
        const currencyMgr = await this.getCurrencyMgr()
        return await currencyMgr.bcRead.getAccountType(this.address)
    }

    public async getTypeLabel (): Promise<string> {
        const accountType = await this.getType()
        for (const [label, value] of Object.entries(this.parent.accountTypeToInt)) {
            if (value === accountType) {
                return label
            }
        }
        throw new Error(`Unknown account type value: ${accountType}`)
    }


    @ttlcache({ttl: 5})
    private async getStatus () {
        const currencyMgr = await this.getCurrencyMgr()
        return await currencyMgr.bcRead.getAccountStatus(this.address)
    }


    public async hasUserAccountValidationRightsForFinancialBackend () {
        let accountType = await this.getType()
        return accountType == 2 || accountType == 4
    }


    public async hasCreditRequestValidationRightsForFinancialBackend () {
        let accountType = await this.getType()
        return accountType == 2 || accountType == 3
    }

    @ttlcache({ttl: 5})
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
    @ttlcache({ttl: 3})
    async getAccountsByAddress (address: string) {
        if (!this.active) return []

        const accounts = []
        const currencyMgr = await this.getCurrencyMgr()
        if (currencyMgr.customization.hasNant()) {
            accounts.push(
                await this.getAccount('Nant', address)
            )
        }
        if (currencyMgr.customization.hasCM()) {
            accounts.push(
                await this.getAccount('Cm', address)
            )
        }
        return accounts
    }

    async getAccounts () {
        return await this.getAccountsByAddress(this.jsonData.address)
    }

    @singleton
    private async getAccount(comchainType: 'Cm' | 'Nant', address: string) {
        const currencyMgr = await this.getCurrencyMgr()
        return new ComchainAccount(
            { comchain: currencyMgr, ...this.backends },
            this,
            {
                address,
                comchain: { type: comchainType },
            }
        )
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
        const myCurrency = this.jsonData.wallet.server.name
        const currencyListMap = await this.backends.comchain.connection.getCurrencyList()
        // contractToCurrency: "0xABC..." -> "Lokacoin"
        const contractToCurrency: Record<string, string> = {}
        for (const [contract, name] of Object.entries(currencyListMap)) {
            contractToCurrency[contract.toLowerCase()] = name as string
        }
        const knownCurrencies = new Set(Object.values(currencyListMap))

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

            // Resolve null currencies by looking up the transactions
            // on chain to get contract addresses, then match against
            // the known currency list (batched, like contact resolution).
            const unresolvedHashes = transactionsData
                .filter((tx: any) => !tx.currency)
                .map((tx: any) => tx.hash)
                .filter(
                    (h: string, idx: number, self: string[]) =>
                        self.indexOf(h) === idx
                )
            if (unresolvedHashes.length > 0) {
                const hashToCurrency: Record<string, string> = {}
                const results = await Promise.all(
                    unresolvedHashes.map((hash: string) =>
                        currencyMgr.ajaxReq
                            .getTransactionInfo(hash)
                            .catch(() => null)
                    )
                )
                for (let i = 0; i < unresolvedHashes.length; i++) {
                    const contractAddr =
                        results[i]?.transaction?.to?.toLowerCase()
                    if (contractAddr && contractToCurrency[contractAddr]) {
                        hashToCurrency[unresolvedHashes[i]] =
                            contractToCurrency[contractAddr]
                    }
                }
                for (const tx of transactionsData) {
                    if (!tx.currency && hashToCurrency[tx.hash]) {
                        tx.currency = hashToCurrency[tx.hash]
                    }
                }
            }

            // Filter transactions by currency:
            // - tx.currency matches ours: keep
            // - tx.currency is another known currency: skip
            // - tx.currency is null (still unresolved) or unknown: keep but flag
            transactionsData = transactionsData.filter((tx: any) => {
                if (tx.currency === myCurrency) return true
                if (tx.currency && knownCurrencies.has(tx.currency)) return false
                return true  // still null or unknown: keep (will be flagged)
            })

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
                const isUnknownCurrency =
                    transactionData.currency !== myCurrency
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
                                isUnknownCurrency,
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
                                isUnknownCurrency,
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


    @ttlcache({ttl: 3})
    public async getCurrencySupply () {
        const currencyMgr = await this.getCurrencyMgr()
        let totalSupply =  await currencyMgr.bcRead.getCurrencySupply()

        for (const technicalAccountAddr of this.parent.technicalAccountAddrs){
            const technicalAccountNantBalance = await currencyMgr.bcRead.getNantBalance(
                technicalAccountAddr
            )
            totalSupply -= technicalAccountNantBalance
        }
        return totalSupply
    }
}


/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe, vi } = import.meta.vitest

    /**
     * Build a minimal ComchainUserAccount-shaped object with a
     * mocked ``backends.comchain.getCurrencyMgr``.
     */
    function makeAccount (backendGetCurrencyMgr: (...args: any[]) => any) {
        return {
            backends: {
                comchain: {
                    getCurrencyMgr: backendGetCurrencyMgr,
                },
            },
            jsonData: { wallet: { server: { name: 'test-server' } } },
            _currencyMgrPromise: null as any,
            _errorsCache: new Map<Error, Error>(),
            getCurrencyMgr: ComchainUserAccount.prototype['getCurrencyMgr'],
        }
    }

    describe('ComchainUserAccount.getCurrencyMgr', () => {

        it('should cache the promise before resolution', async () => {
            let resolve: (v: any) => void
            const pending = new Promise(r => { resolve = r })
            const mock = vi.fn(() => pending)
            const account = makeAccount(mock)

            const p1 = account.getCurrencyMgr()
            const p2 = account.getCurrencyMgr()

            expect(mock).toHaveBeenCalledTimes(1)
            const fakeMgr = { fake: 'currencyMgr' }
            resolve!(fakeMgr)
            expect(await p1).toBe(fakeMgr)
            expect(await p2).toBe(fakeMgr)
        })

        it('should cache the promise after resolution', async () => {
            const fakeMgr = { fake: 'currencyMgr' }
            const mock = vi.fn(() => Promise.resolve(fakeMgr))
            const account = makeAccount(mock)

            const r1 = await account.getCurrencyMgr()
            const r2 = await account.getCurrencyMgr()

            expect(mock).toHaveBeenCalledTimes(1)
            expect(r1).toBe(fakeMgr)
            expect(r2).toBe(fakeMgr)
        })

        it('should allow retry after rejection', async () => {
            const fakeMgr = { fake: 'currencyMgr' }
            const mock = vi.fn()
                .mockRejectedValueOnce(new Error('network failure'))
                .mockResolvedValueOnce(fakeMgr)
            const account = makeAccount(mock)

            await expect(account.getCurrencyMgr()).rejects.toThrow('network failure')
            const result = await account.getCurrencyMgr()

            expect(mock).toHaveBeenCalledTimes(2)
            expect(result).toBe(fakeMgr)
        })

        it('should wrap NoEndpointAvailable into BackendUnavailableTransient', async () => {
            const noEndpoint = new Jsc3lException.NoEndpointAvailable('no server')
            const mock = vi.fn(() => Promise.reject(noEndpoint))
            const account = makeAccount(mock)

            await expect(account.getCurrencyMgr()).rejects.toBeInstanceOf(
                e.BackendUnavailableTransient
            )
        })

        it('should return identical error objects for the same NoEndpointAvailable instance', async () => {
            const noEndpoint = new Jsc3lException.NoEndpointAvailable('no server')
            const mock = vi.fn(() => Promise.reject(noEndpoint))
            const account = makeAccount(mock)

            const err1 = await account.getCurrencyMgr().catch((e: Error) => e)
            const err2 = await account.getCurrencyMgr().catch((e: Error) => e)

            expect(err1).toBe(err2)
        })

        it('should return different error objects for different NoEndpointAvailable instances', async () => {
            const noEndpoint1 = new Jsc3lException.NoEndpointAvailable('server A')
            const noEndpoint2 = new Jsc3lException.NoEndpointAvailable('server B')
            const mock = vi.fn()
                .mockRejectedValueOnce(noEndpoint1)
                .mockRejectedValueOnce(noEndpoint2)
            const account = makeAccount(mock)

            const err1 = await account.getCurrencyMgr().catch((e: Error) => e)
            const err2 = await account.getCurrencyMgr().catch((e: Error) => e)

            expect(err1).not.toBe(err2)
            expect(err1).toBeInstanceOf(e.BackendUnavailableTransient)
            expect(err2).toBeInstanceOf(e.BackendUnavailableTransient)
        })

        it('should pass server name to backend getCurrencyMgr', async () => {
            const mock = vi.fn(() => Promise.resolve({ fake: 'mgr' }))
            const account = makeAccount(mock)

            await account.getCurrencyMgr()

            expect(mock).toHaveBeenCalledWith('test-server')
        })
    })
}
