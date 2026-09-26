import React from 'react';
import classNames from 'classnames';
import { useRunPanelLayout } from '@/hooks/useRunPanelLayout';
import { LabelPairedChevronsRightCaptionRegularIcon, LegacyHandleLessIcon } from '@deriv/quill-icons';

type TDrawer = {
    anchor?: string;
    className?: string;
    contentClassName?: string;
    footer?: React.ReactElement;
    header?: React.ReactElement;
    width?: number;
    zIndex?: number;
    is_open: boolean;
    toggleDrawer?: (prop: boolean) => void;
};

const Drawer = ({
    anchor = 'left',
    children,
    className,
    contentClassName,
    footer,
    header,
    width = 250,
    zIndex = 4,
    ...props
}: React.PropsWithChildren<TDrawer>) => {
    const [is_open, setIsOpen] = React.useState(props.is_open);
    // Layout (docked side drawer vs bottom sheet) comes from one shared hook so
    // the markup and the stylesheet can never disagree — see useRunPanelLayout.
    const { is_side_layout } = useRunPanelLayout();

    React.useEffect(() => {
        setIsOpen(props.is_open);
    }, [props.is_open]);

    const toggleDrawer = () => {
        setIsOpen(!is_open);
        if (props.toggleDrawer) {
            props.toggleDrawer(!is_open);
        }
    };

    return (
        <div
            data-testid='drawer'
            className={classNames('dc-drawer', className, {
                [`dc-drawer--${anchor}`]: is_side_layout,
                'dc-drawer--side': is_side_layout,
                'dc-drawer--sheet': !is_side_layout,
                'dc-drawer--open': is_open,
            })}
            style={{
                zIndex,
                transform:
                    is_open && is_side_layout
                        ? anchor === 'left'
                            ? `translateX(calc(${width}px - 16px))`
                            : `translateX(calc(-${width}px + 16px))`
                        : undefined,
            }}
        >
            <div
                className={classNames('dc-drawer__toggle', {
                    'dc-drawer__toggle--open': is_open,
                })}
                onClick={toggleDrawer}
            >
                {is_side_layout ? (
                    <LabelPairedChevronsRightCaptionRegularIcon
                        className={classNames('dc-drawer__toggle-icon', {
                            [`dc-drawer__toggle-icon--${anchor}`]: is_side_layout,
                        })}
                    />
                ) : (
                    <LegacyHandleLessIcon iconSize='sm' className='dc-drawer__toggle-icon' />
                )}
            </div>
            <div className={classNames('dc-drawer__container', { [`dc-drawer__container--${anchor}`]: is_side_layout })}>
                {header && <div className='dc-drawer__header'>{header}</div>}
                <div className={classNames('dc-drawer__content', contentClassName)}>{children}</div>
                {footer && <div className='dc-drawer__footer'>{footer}</div>}
            </div>
        </div>
    );
};

export default Drawer;
