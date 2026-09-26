import React from 'react';
import { render, screen } from '@testing-library/react';
import { RUN_PANEL_SIDE_LAYOUT_QUERY } from '@/hooks/useRunPanelLayout';
import Drawer from '../drawer';

/**
 * The results drawer must dock to the right on desktop and only become a bottom
 * sheet on touch devices. It previously keyed off `min-width: 1280px`, so a
 * desktop browser showing the builder in a narrower iframe (the normal case in
 * the NeuroTrade shell) was served the phone layout.
 */
const mockViewport = (matches_side_layout: boolean) => {
    const listeners = new Set<() => void>();
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: query === RUN_PANEL_SIDE_LAYOUT_QUERY ? matches_side_layout : false,
        media: query,
        onchange: null,
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
        dispatchEvent: () => false,
    }));
};

const renderDrawer = () =>
    render(
        <Drawer anchor='right' is_open width={293}>
            <div>results</div>
        </Drawer>
    );

describe('Drawer layout', () => {
    it('docks to the right on a roomy, mouse-driven viewport', () => {
        mockViewport(true);
        renderDrawer();

        const drawer = screen.getByTestId('drawer');
        expect(drawer).toHaveClass('dc-drawer--side');
        expect(drawer).toHaveClass('dc-drawer--right');
        expect(drawer).not.toHaveClass('dc-drawer--sheet');
        // Opened side drawer slides in by its own width (minus the 16px handle).
        expect(drawer.style.transform).toBe('translateX(calc(-293px + 16px))');
    });

    it('falls back to the bottom sheet on touch viewports', () => {
        mockViewport(false);
        renderDrawer();

        const drawer = screen.getByTestId('drawer');
        expect(drawer).toHaveClass('dc-drawer--sheet');
        expect(drawer).not.toHaveClass('dc-drawer--side');
        expect(drawer).not.toHaveClass('dc-drawer--right');
        // The sheet is translated by the stylesheet, never inline.
        expect(drawer.style.transform).toBe('');
    });

    it('asks for horizontal room AND a fine pointer, not a 1280px device width', () => {
        expect(RUN_PANEL_SIDE_LAYOUT_QUERY).toBe('(min-width: 768px) and (pointer: fine)');
    });
});
