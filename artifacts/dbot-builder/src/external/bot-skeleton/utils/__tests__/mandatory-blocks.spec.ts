import {
    expandMandatoryBlockTypes,
    getMandatoryBlockAlternatives,
    getMandatoryBlockFamily,
    isMandatoryBlockPresent,
} from '../mandatory-blocks';

describe('mandatory block stand-ins', () => {
    it('maps the paired purchase block onto the mandatory Purchase block', () => {
        expect(getMandatoryBlockAlternatives('purchase')).toEqual(['purchase_pair']);
        expect(getMandatoryBlockFamily('purchase')).toEqual(['purchase', 'purchase_pair']);
    });

    it('has no stand-ins for blocks that do not define any', () => {
        expect(getMandatoryBlockAlternatives('trade_definition')).toEqual([]);
        expect(getMandatoryBlockFamily('trade_definition')).toEqual(['trade_definition']);
    });

    it('expands a required list without duplicating entries', () => {
        expect(expandMandatoryBlockTypes(['trade_definition', 'purchase', 'purchase'])).toEqual([
            'trade_definition',
            'purchase',
            'purchase_pair',
        ]);
    });

    it('treats purchase_pair as a present Purchase block', () => {
        expect(isMandatoryBlockPresent('purchase', ['before_purchase', 'purchase_pair'])).toBe(true);
        expect(isMandatoryBlockPresent('purchase', ['before_purchase', 'purchase'])).toBe(true);
        expect(isMandatoryBlockPresent('purchase', ['before_purchase'])).toBe(false);
    });
});
