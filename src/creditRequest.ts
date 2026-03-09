import { t, e } from '@lokavaluto/lokapi'
import CreditRequest from '@lokavaluto/lokapi/build/backend/odoo/creditRequest'

import { sleep, queryUntil } from '@lokavaluto/lokapi/build/utils'



export class ComchainCreditRequest extends CreditRequest
    implements t.ICreditRequest {

    get currency () {
        return this.backends.comchain.customization.cfg.server.currencies.CUR
    }

    get id () {
        return this.jsonData.comchain.hash
    }

    public async validate () {
        // XXXvlab: yuck, there need to be a clean up and rationalisation
        //   of these backends and jsonData link madness

        const userAccount = this.parent
        const jsc3l = userAccount.parent.jsc3l
        const { amount, credit_id } = this.jsonData.odoo
        const destAddress = this.jsonData.comchain.address

        if (!(await userAccount.isActiveAccount())) {
            throw new e.InactiveAccount(
                "You can't validate credit requests from an inactive account."
            )
        }

        if (!(await userAccount.hasCreditRequestValidationRightsForFinancialBackend())) {
            throw new e.PermissionDenied(
                'You need to be admin to validate credit requests'
            )
        }

        const messageKey = await jsc3l.ajaxReq.getMessageKey(
            `0x${destAddress}`,
            false
        )

        const data = jsc3l.memo.getTxMemoCipheredData(
            null,
            messageKey.public_message_key,
            null,
            ''
        )

        const clearWallet = await userAccount.unlockWallet()

        await jsc3l.bcTransaction.pledgeAccount(
            clearWallet,
            `0x${destAddress}`,
            amount,
            data
        )

        const res = await this.backends.odoo.$post(
            '/partner/validate-credit-request',
            { ids: [credit_id] }
        )
        if (!res) {
            throw new Error(
                `Admin backend refused activation of ${destAddress}`
            )
        }

        return
    }

}
