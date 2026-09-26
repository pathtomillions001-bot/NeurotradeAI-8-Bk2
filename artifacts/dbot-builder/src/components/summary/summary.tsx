import classnames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useRunPanelLayout } from '@/hooks/useRunPanelLayout';
import { useStore } from '@/hooks/useStore';
import ThemedScrollbars from '../shared_ui/themed-scrollbars';
import SummaryCard from './summary-card';

type TSummary = {
    is_drawer_open: boolean;
};

const Summary = observer(({ is_drawer_open }: TSummary) => {
    const { dashboard, summary_card } = useStore();
    const { is_contract_loading, contract_info, is_bot_running } = summary_card;
    const { active_tour } = dashboard;
    // Tab sizing follows the run-panel layout (docked drawer vs bottom sheet).
    const { is_side_layout } = useRunPanelLayout();
    return (
        <div
            className={classnames({
                'run-panel-tab__content': is_side_layout,
                'run-panel-tab__content--mobile': !is_side_layout && is_drawer_open,
                'run-panel-tab__content--summary-tab': (is_side_layout && is_drawer_open) || active_tour,
            })}
            data-testid='mock-summary'
        >
            <ThemedScrollbars
                className={classnames({
                    summary: (!is_contract_loading && !contract_info) || is_bot_running,
                    'summary--loading':
                        (!is_side_layout && is_contract_loading) ||
                        (!is_side_layout && !is_contract_loading && contract_info),
                })}
            >
                <SummaryCard
                    is_contract_loading={is_contract_loading}
                    contract_info={contract_info}
                    is_bot_running={is_bot_running}
                />
            </ThemedScrollbars>
        </div>
    );
});

export default Summary;
