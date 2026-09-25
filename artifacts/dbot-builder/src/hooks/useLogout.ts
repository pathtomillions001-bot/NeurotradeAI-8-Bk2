import { useCallback } from 'react';
import { clearAuthInfo } from '@/external/deriv-core';
import { useStore } from '@/hooks/useStore';
import { ErrorLogger } from '@/utils/error-logger';

/**
 * Custom hook to handle logout functionality
 * Clears all session and local storage to reset the session
 * @returns {Function} handleLogout - Function to trigger the logout process
 */
export const useLogout = () => {
    const { client } = useStore() ?? {};

    return useCallback(async () => {
        try {
            // Call the client store logout method which clears all storage
            await client?.logout();
            // Analytics.reset() removed - Analytics package has been removed from the project
            // See migrate-docs/MONITORING_PACKAGES.md for re-enabling analytics if needed
        } catch (error) {
            ErrorLogger.error('Logout', 'Logout failed', error);
            // If logout fails, clear only auth-related storage keys
            // This preserves user preferences (theme, language, etc.) while ensuring auth data is cleared
            try {
                // Clear auth token via vendored deriv-core
                clearAuthInfo();

                // Clear auth-related localStorage items
                localStorage.removeItem('active_loginid');
                localStorage.removeItem('authToken');
                localStorage.removeItem('accountsList');
                localStorage.removeItem('clientAccounts');
                localStorage.removeItem('account_type');
            } catch (storageError) {
                ErrorLogger.error('Logout', 'Failed to clear auth storage', storageError);
                // Last resort: still only drop the auth-scoped keys. Clearing
                // storage wholesale also threw away the run history the builder
                // keeps until the user presses Reset (transaction_cache,
                // journal_cache) and the host app's tab-session keys.
                try {
                    ['deriv_accounts', 'query_param_currency', 'client_account_details', 'session_token'].forEach(key =>
                        sessionStorage.removeItem(key)
                    );
                    ['active_loginid', 'authToken', 'accountsList', 'clientAccounts', 'account_type'].forEach(key =>
                        localStorage.removeItem(key)
                    );
                } catch (finalError) {
                    ErrorLogger.error('Logout', 'Failed to clear auth storage', finalError);
                }
            }
        }
    }, [client]);
};
