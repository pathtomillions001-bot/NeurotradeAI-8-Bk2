import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeAutoObservable } from 'mobx';
import { DBOT_TABS } from '../../constants/bot-contents';
import RunPanel from '../../components/run-panel/run-panel';

let mockStore;
jest.mock('@/hooks/useStore', () => ({ useStore: () => mockStore }));
jest.mock('@deriv-com/ui', () => ({ useDevice: () => ({ isDesktop: false, isMobile: true }) }));
jest.mock('@/components/summary', () => () => <div data-testid='summary-tab'>Summary content</div>);
jest.mock('@/components/transactions', () => () => <div data-testid='transactions-tab'>Transactions content</div>);
jest.mock('@/components/journal', () => () => <div data-testid='journal-tab'>Journal content</div>);
jest.mock('@/components/trade-animation', () => () => <button type='button' data-testid='mobile-run-stop'>Run / Stop</button>);
jest.mock('@/components/shared_ui/modal', () => () => null);
jest.mock('@/components/shared_ui/money', () => () => <span>0.00</span>);
jest.mock('@/components/shared_ui/tabs', () => ({ children }) => <div data-testid='drawer-tabs'>{children}</div>);

test('mobile Run/Stop stays available with drawer closed; the handle opens all three tabs', () => {
    const runPanel = makeAutoObservable({
        is_drawer_open: false, active_index: 0, is_statistics_info_modal_open: false,
        is_clear_stat_disabled: false,
        onClearStatClick: () => {}, onMount: () => {}, onUnmount: () => {},
        toggleDrawer: value => { runPanel.is_drawer_open = value; },
        setActiveTabIndex() {}, toggleStatisticsInfoModal() {},
    });
    mockStore = {
        run_panel: runPanel,
        dashboard: { active_tab: DBOT_TABS.BOT_BUILDER, active_tour: '' },
        transactions: { statistics: {
            total_payout: 0, total_profit: 0, total_stake: 0, won_contracts: 0,
            lost_contracts: 0, number_of_runs: 0,
        } },
        client: { currency: 'USD' },
    };
    const { container } = render(<RunPanel />);
    const toggle = container.querySelector('.dc-drawer__toggle');
    expect(toggle).not.toBeNull();
    expect(screen.getByTestId('mobile-run-stop')).toBeVisible();
    expect(screen.queryByTestId('drawer-tabs')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(runPanel.is_drawer_open).toBe(true);
    expect(screen.getByTestId('drawer-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('summary-tab')).toBeInTheDocument();
    expect(screen.getByTestId('transactions-tab')).toBeInTheDocument();
    expect(screen.getByTestId('journal-tab')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-run-stop')).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('drawer-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-run-stop')).toBeVisible();
});
