
/**
 * Convert an integer amount in cents to a formatted string.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(intCents2strAmount(0n)).toBe("0.00")
 * expect(intCents2strAmount(100n)).toBe("1.00")
 * expect(intCents2strAmount(-150n)).toBe("-1.50")
 * ```
 */
let intCents2strAmount = (dataIntCents: bigint): string => {
    let sign = ""
    if (dataIntCents < 0n) {
        dataIntCents = -dataIntCents
        sign = "-"
    }
    let dataStr = dataIntCents.toString().padStart(3, "0")
    return `${sign}${dataStr.slice(0,-2)}.${dataStr.slice(-2)}`
}

let strAmount2intCents = (dataStrAmount: string): bigint => {
    // Check format XX...XX.YY
    if (!/^-?[0-9]+\.[0-9]{2}$/.test(dataStrAmount)) {
        throw Error(`Unexpected amount string: ${JSON.stringify(dataStrAmount)}`)
    }
    return BigInt(dataStrAmount.replace(".", ""))
}

export { intCents2strAmount, strAmount2intCents }

/* @skip-prod-transpilation */
if (import.meta.vitest) {
    const { it, expect, describe } = import.meta.vitest
    describe('str -> cents amounts', () => {
        it('should decode "0.00" to 0n', () => {
            expect(strAmount2intCents('0.00')).toBe(0n)
        })
        it('should decode "-0.00" to 0n', () => {
            expect(strAmount2intCents('-0.00')).toBe(0n)
        })
        it('should decode "-1.00" to -100n', () => {
            expect(strAmount2intCents('-1.00')).toBe(-100n)
        })
        it('should decode "-0.01" to 1n', () => {
            expect(strAmount2intCents('-0.01')).toBe(-1n)
        })
        // Exceptions
        it('should refuse to encode ""', () => {
            expect(() => strAmount2intCents(''))
                .toThrowError('amount string')
        })
        it('should refuse to encode "0"', () => {
            expect(() => strAmount2intCents('0'))
                .toThrowError('amount string')
        })
        it('should refuse to encode "0.0"', () => {
            expect(() => strAmount2intCents('0.0'))
                .toThrowError('amount string')
        })
        it('should refuse to encode ".00"', () => {
            expect(() => strAmount2intCents('.00'))
                .toThrowError('amount string')
        })
        it('should refuse to encode "0.000"', () => {
            expect(() => strAmount2intCents('0.000'))
                .toThrowError('amount string')
        })
    })
    describe('cents -> str amounts', () => {
        it('should decode 0n to "0.00" (enforce 2 digit after floating point)', () => {
            expect(intCents2strAmount(0n)).toBe('0.00')
        })
        it('should decode 1n to "0.01"', () => {
            expect(intCents2strAmount(1n)).toBe('0.01')
        })
        it('should decode -0n to "0.00" (favor removing minus sign)', () => {
            expect(intCents2strAmount(-0n)).toBe('0.00')
        })
        it('should decode -100n to "-1.00"', () => {
            expect(intCents2strAmount(-100n)).toBe('-1.00')
        })
        it('should decode 123456789123456789n to "1234567891234567.89" (support large ints)', () => {
            expect(intCents2strAmount(123456789123456789n)).toBe("1234567891234567.89")
        })
    })
}
