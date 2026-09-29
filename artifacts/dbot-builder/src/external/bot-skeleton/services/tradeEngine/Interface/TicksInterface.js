const getTicksInterface = tradeEngine => {
    return {
        getDelayTickValue: (...args) => tradeEngine.getDelayTickValue(...args),
        getCurrentStat: (...args) => tradeEngine.getCurrentStat(...args),
        getStatList: (...args) => tradeEngine.getStatList(...args),
        getLastTick: (...args) => tradeEngine.getLastTick(...args),
        getLastDigit: (...args) => tradeEngine.getLastDigit(...args),
        getTicks: (...args) => tradeEngine.getTicks(...args),
        checkDirection: (...args) => tradeEngine.checkDirection(...args),
        getOhlcFromEnd: (...args) => tradeEngine.getOhlcFromEnd(...args),
        getOhlc: (...args) => tradeEngine.getOhlc(...args),
        getLastDigitList: (...args) => tradeEngine.getLastDigitList(...args),
        ntAnalyseDigitMarkets: (...args) => tradeEngine.ntAnalyseDigitMarkets(...args),
        ntDigitDecision: (...args) => tradeEngine.ntDigitDecision(...args),
        ntAnalyseContracts: (...args) => tradeEngine.ntAnalyseContracts(...args),
        ntContractDecision: (...args) => tradeEngine.ntContractDecision(...args),
        ntAnalyseSurgeMarkets: (...args) => tradeEngine.ntAnalyseSurgeMarkets(...args),
        ntSurgeDecision: (...args) => tradeEngine.ntSurgeDecision(...args),
        ntAnalyseTurboRecovery: (...args) => tradeEngine.ntAnalyseTurboRecovery(...args),
        ntTurboRecoveryDecision: (...args) => tradeEngine.ntTurboRecoveryDecision(...args),
        ntAnalyseDualLockEntry: (...args) => tradeEngine.ntAnalyseDualLockEntry(...args),
        ntDualLockEntryDecision: (...args) => tradeEngine.ntDualLockEntryDecision(...args),
        ntAnalyseBastionEntry: (...args) => tradeEngine.ntAnalyseBastionEntry(...args),
        ntBastionEntryDecision: (...args) => tradeEngine.ntBastionEntryDecision(...args),
        ntAnalyseCombo: (...args) => tradeEngine.ntAnalyseCombo(...args),
        ntComboDecision: (...args) => tradeEngine.ntComboDecision(...args),
        ntSwitchMarket: (...args) => tradeEngine.ntSwitchMarket(...args),
    };
};

export default getTicksInterface;
