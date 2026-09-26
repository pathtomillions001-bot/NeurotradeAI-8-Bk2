import React from 'react';

/**
 * Run-panel layout — ONE source of truth for JS and CSS.
 *
 * The results panel (Summary / Transactions / Journal) has two layouts:
 *
 *  - **side**: a drawer docked to the right edge of the workspace, the classic
 *    desktop arrangement;
 *  - **sheet**: a bottom sheet whose handle sits just above the persistent
 *    Run/Stop bar, the touch arrangement.
 *
 * It used to be driven by `useDevice().isDesktop`, i.e. `min-width: 1280px`,
 * mirrored by the `mobile-or-tablet-screen` SCSS mixin. The builder runs inside
 * the NeuroTrade shell's iframe, which on a normal laptop is a few hundred
 * pixels narrower than the browser window — under 1280px — so real desktop
 * users were served the bottom sheet meant for phones.
 *
 * The layout now keys off the two things that actually matter: enough
 * horizontal room for a docked drawer, and a precise pointer (mouse/trackpad).
 * Phones and tablets keep the sheet; desktops keep the side drawer no matter
 * how narrow the embedding frame is.
 */
export const RUN_PANEL_SIDE_LAYOUT_QUERY = '(min-width: 768px) and (pointer: fine)';

/** Synchronous read, safe in SSR and in environments without matchMedia. */
export const matchesRunPanelSideLayout = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia(RUN_PANEL_SIDE_LAYOUT_QUERY).matches;
};

export type TRunPanelLayout = {
    /** Drawer docked to the right edge (desktop). */
    is_side_layout: boolean;
    /** Bottom sheet above the Run/Stop bar (phones and tablets). */
    is_sheet_layout: boolean;
};

export const useRunPanelLayout = (): TRunPanelLayout => {
    const [is_side_layout, setIsSideLayout] = React.useState<boolean>(matchesRunPanelSideLayout);

    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

        const media_query = window.matchMedia(RUN_PANEL_SIDE_LAYOUT_QUERY);
        const onChange = () => setIsSideLayout(media_query.matches);

        onChange();
        if (typeof media_query.addEventListener === 'function') {
            media_query.addEventListener('change', onChange);
            return () => media_query.removeEventListener('change', onChange);
        }
        // Safari < 14 and jsdom's older MediaQueryList shim.
        media_query.addListener?.(onChange);
        return () => media_query.removeListener?.(onChange);
    }, []);

    return { is_side_layout, is_sheet_layout: !is_side_layout };
};

export default useRunPanelLayout;
