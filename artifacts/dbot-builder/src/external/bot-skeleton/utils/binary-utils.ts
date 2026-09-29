import { TickSpotData } from '@deriv/api-types';

export const getLast = (arr: any[]): any => arr && (arr.length === 0 ? undefined : arr[arr.length - 1]);

export const historyToTicks = (history: any): TickSpotData[] => {
    const times = Array.isArray(history?.times) ? history.times : [];
    const prices = Array.isArray(history?.prices) ? history.prices : [];

    return times
        .map((t, idx) => ({
            epoch: +t,
            quote: +prices[idx],
        }))
        .filter(tick => Number.isFinite(tick.epoch) && Number.isFinite(tick.quote));
};
