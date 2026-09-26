import React from 'react';
import { render, screen } from '@testing-library/react';
import AppContent from '../../app/app-content';

const mockSetDBotEngineStores = jest.fn();
const mockStore = {
    app: { setDBotEngineStores: mockSetDBotEngineStores },
    common: { error: null, current_language: 'EN', setSocketOpened: jest.fn() },
    client: { is_logged_in: false, loginid: '' },
    transactions: { recovered_transactions: [], recoverPendingContracts: jest.fn() },
};
jest.mock('@/hooks/useStore', () => ({ useStore: () => mockStore }));
jest.mock('@/hooks/useApiBase', () => ({ useApiBase: () => ({ connectionStatus: 'unknown' }) }));
jest.mock('@/hooks/useThemeSwitcher', () => () => ({ is_dark_mode_on: true }));
jest.mock('@/hooks/useDevMode', () => () => {});
jest.mock('@/components/chat/useLiveChat', () => () => {});
jest.mock('@/components/shared', () => ({ getUrlBase: path => path }));
jest.mock('@/external/bot-skeleton', () => ({
    api_base: { api: null }, ApiHelpers: { setInstance: jest.fn() }, ServerTime: { init: jest.fn() },
}));
jest.mock('@deriv-com/smartcharts-champion', () => ({ setSmartChartsPublicPath: jest.fn() }));
jest.mock('@deriv-com/quill-ui', () => ({ ThemeProvider: ({ children }) => <>{children}</> }));
jest.mock('@/utils/is-preview-mode', () => ({ isPreviewMode: () => true }));
jest.mock('@/components/auth-loading-wrapper', () => ({ children }) => <>{children}</>);
jest.mock('@/components/blockly-loading', () => () => null);
jest.mock('../../pages/bot-builder', () => () => <div data-testid='editable-builder' />);
jest.mock('../../pages/main', () => () => <div data-testid='builder-navigation' />);
jest.mock('@/components/audio', () => () => null);
jest.mock('@/components/bot-stopped', () => () => null);
jest.mock('@/components/transaction-details', () => () => null);

test('the editor becomes available without waiting for a Deriv socket or active_symbols', () => {
    render(<AppContent />);
    expect(mockSetDBotEngineStores).toHaveBeenCalledTimes(1);
    expect(require('@/external/bot-skeleton').ApiHelpers.setInstance).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('editable-builder')).toBeInTheDocument();
    expect(screen.getByTestId('builder-navigation')).toBeInTheDocument();
    expect(screen.queryByText(/Initializing Deriv Bot account/)).not.toBeInTheDocument();
});
