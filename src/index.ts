import Jsc3lAbstract from '@com-chain/jsc3l'

import { t, e } from '@lokavaluto/lokapi'
import { mux } from '@lokavaluto/lokapi/build/generator'
import { BackendAbstract } from '@lokavaluto/lokapi/build/backend'

import { ComchainAccount } from './account'
import { ComchainRecipient } from './recipient'
import { ComchainTransaction } from './transaction'
import { ComchainCreditRequest } from './creditRequest'


interface IJsonDataWithAddress extends t.JsonData {
    address: string
}


/** Password checking utilities */

const PASSWORD_REGEX = {
    tooShort: (size:number) => RegExp(`.{${size},}`),
    noUpperCase: /[A-Z]/,
    noLowerCase: /[a-z]/,
    noDigit: /[0-9]/,
    noSymbol: /[^A-Za-z0-9]/

}


function makePasswordChecker(checks: Array<String>): (password: string) => Array<string> {
    return (password) => {
        const issues = []
        checks.forEach((checkStr) => {
            const [ checkId, argsStr ] = checkStr.split(':')
            const args = (argsStr || '').split(',')
            let check = PASSWORD_REGEX[checkId]
            if (!check) {
                throw new Error(`Invalid check identifier ${checkId}`)
            }
            check = check instanceof RegExp ? check : check.apply(null, [args])

            if (!check.test(password)) issues.push(checkStr)
        })
        return issues
    }
}


export default abstract class ComchainBackendAbstract extends BackendAbstract {

    _jsc3l: Jsc3lAbstract

    get jsc3l () {
        if (!this._jsc3l) {
            const {
                httpRequest,
                persistentStore,
            } = this
            class Jsc3l extends Jsc3lAbstract {
                persistentStore = persistentStore
                httpRequest = async (opts) => {
                    if (opts.method === 'POST') {
                        opts.headers = opts.header || {}
                        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'
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

    private getSubBackend (jsc3l: Jsc3lAbstract, jsonData: IJsonDataWithAddress) {
        return new ComchainUserAccount({
            comchain: jsc3l,
            ...this.backends
        }, this, jsonData)
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

    public async getUserAccounts (): Promise<any> {
        return this.userAccounts
    }

    public async getAccounts (): Promise<any> {
        const backendBankAccounts = []
        // XXXvlab: make paralell wait
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

        const userAccount = Object.values(this.userAccounts)[0] as ComchainUserAccount
        return userAccount.makeCreditRequest(jsonData)
    }

    public async * getTransactions (order:any): AsyncGenerator {
        yield * mux(
            Object.values(this.userAccounts).map(
                (u: ComchainUserAccount) => u.getTransactions(order)),
            order
        )
    }

    isPasswordStrongEnoughSync = makePasswordChecker([
        "tooShort:8",
        "noUpperCase",
        "noLowerCase",
        "noDigit",
        // "noSymbol",
    ])

    public async isPasswordStrongEnough (password:string): Promise<Array<string>> {
        return this.isPasswordStrongEnoughSync(password)
    }

    public async createUserAccount ({ password }): Promise<ComchainUserAccount> {
        const currencyMgr = await this.jsc3l.getCurrencyMgr(
            this.jsonData.type.split(':')[1],
        )
        const wallet = await currencyMgr.wallet.createWallet()
        const cipheredWallet = wallet.encryptWallet(password)
        let res = await this.backends.odoo.$post('/comchain/register', {
            address: cipheredWallet.address,
            wallet: JSON.stringify(cipheredWallet),
            message_key: wallet.messageKeysFromWallet(),
        })
        if (res.error) {
            console.error(`Failed to create user account: ${res.error}`)
            if (res.error === "account already exists") {
                throw new e.UserAccountAlreadyExists(res.error)
            }
            throw new Error(res.error)
        }
        return this.getSubBackend(this.jsc3l, {
            active: false,
            address: cipheredWallet.address,
            wallet: cipheredWallet,
            message_key: wallet.messageKeysFromWallet(),
        })
    }

}


export class ComchainUserAccount {

    address: string
    parent: BackendAbstract
    backends: { [index: string]: any }
    jsonData: { [index: string]: any }


    constructor (backends, parent, jsonData) {
        this.address = jsonData.wallet.address
        this.parent = parent
        this.backends = backends
        this.jsonData = jsonData
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

    private async getCurrencyMgr () {
        if (!this._currencyMgrPromise) {
            // This will trigger the discovery of master servers and load
            // the server conf of the currency.
            this._currencyMgrPromise = this.backends.comchain.getCurrencyMgr(
                this.jsonData.wallet.server.name,
            )
        }
        return await this._currencyMgrPromise
    }

    _currencyMgrPromise: { [index: string]: any }


    /**
     * getBalance on the User Account sums all the balances of user accounts
     */
    public async getBalance (): Promise<number> {
        const bankAccounts = await this.getAccounts()
        const balances = await Promise.all(
            bankAccounts.map((bankAccount: any) => bankAccount.getBalance())
        )
        return <number>balances.map(
            (a:string) => parseFloat(a)
        ).reduce((s: number, a:number) => s + a, 0)
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
            this._status = await currencyMgr.bcRead.getAccountStatus(this.address)
        }
        return this._status
    }


    public async hasUserAccountValidationRights () {
        // In comchain, either you are admin or not
        return (await this.getType()) == 2
    }


    public async hasCreditRequestValidationRights () {
        // In comchain, either you are admin or not
        return (await this.getType()) == 2
    }

    public async isActiveAccount () {
        return (await this.getStatus()) == 1
    }

    public async requiresUnlock () {
        return true
    }

    /**
     * Use `requestLocalPassword` that is provided by the GUI to
     * return the decrypted wallet.
     */
    public async unlockWallet(requestCredentialsFromUserFn: any) {
        let [ _password, wallet ] = await this._unlockWallet(requestCredentialsFromUserFn)
        return wallet
    }

    /**
     * Use `requestLocalPassword` that is provided by the GUI to
     * check and return the valid wallet password.
     */
    public async requestCredentials(requestCredentialsFromUserFn: any) {
        let [ password, _wallet ] = await this._unlockWallet(requestCredentialsFromUserFn)
        return password
    }

    /**
     * This action will use `requestLocalPassword` that is provided by
     * the GUI.
     */
    private async _unlockWallet(requestCredentialsFromUserFn?) {
        let password
        let state = 'firstTry'
        requestCredentialsFromUserFn = requestCredentialsFromUserFn || this.parent.requestLocalPassword
        while (true) {
            password = await requestCredentialsFromUserFn(state, this)
            try {
                return [
                    password,
                    this.backends.comchain.wallet.getWalletFromPrivKeyFile(
                        JSON.stringify(this.jsonData.wallet), password),
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
                            type: 'Nant'
                        },
                    })
            )
        }
        if (currencyMgr.customization.hasCM()) {
            accounts.push(
                new ComchainAccount(
                    { comchain: this, ...this.backends },
                    this, {
                        comchain: { type: 'Cm' },
                    })
            )
        }
        return accounts
    }

    get internalId () {
        return `comchain:${this.address}`
    }

    public async * getTransactions (order: any): AsyncGenerator {
        if (!this.active) return

        const currencyMgr = await this.getCurrencyMgr()
        const addressResolve = {}
        const limit = 30
        let offset = 0
        while (true) {
            const transactionsData = await currencyMgr.ajaxReq.getTransList(
                `0x${this.address}`, limit, offset)
            const uniqueAddresses = transactionsData.map(
                (t: any) => t[t.direction === 2 ? "addr_from" : "addr_to"]
            ).filter(
                (t: any, idx: number, self) => (self.indexOf(t) === idx) &&
                    (typeof addressResolve[t] === 'undefined') &&
                    (t !== 'Admin')
            ).map(
                (t: any) => t.substring(2)
            )
            if (uniqueAddresses.length > 0) {
                const partners = await this.backends.odoo.$post('/comchain/partners', {
                    addresses: uniqueAddresses,
                })
                for (const k in partners) {
                    addressResolve[k] = partners[k]
                }
            }
            for (let idx = 0; idx < transactionsData.length; idx++ ) {
                const transactionData = transactionsData[idx]
                if (transactionData.addr_to === `0x${this.address}`) {
                    yield new ComchainTransaction(
                        {
                            ...this.backends,
                            ...{ comchain: currencyMgr }
                        },
                        this,
                        {
                            comchain: Object.assign({}, transactionData, {
                                amount: transactionData.recieved
                            }),
                            odoo: addressResolve
                        }
                    )
                }
                if (transactionData.addr_from === `0x${this.address}`) {
                    yield new ComchainTransaction(
                        {
                            ...this.backends,
                            ...{ comchain: currencyMgr }
                        },
                        this,
                        {
                            comchain: Object.assign({}, transactionData, {
                                amount: -transactionData.sent
                            }),
                            odoo: addressResolve
                        }
                    )
                }
            }
            if (transactionsData.length < limit) {
                return
            }
            offset += limit
        }
    }

    public async makeCreditRequest (jsonData: t.JsonData): Promise<t.ICreditRequest> {
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
