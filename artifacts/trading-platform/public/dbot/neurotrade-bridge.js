/**
 * NeuroTrade Bridge for Deriv Bot Builder
 * Synchronizes authentication, accounts, strategy XML loading, and execution events
 * between NeuroTrade parent window and embedded Deriv Bot.
 */
(function() {
  const isEmbedded = window.parent && window.parent !== window;

  function log(...args) {
    console.log('[neurotrade-bridge]', ...args);
  }

  // Set up listeners for messages from NeuroTrade host
  window.addEventListener('message', async function(event) {
    const data = event.data;
    if (!data || data.source !== 'nt-host' || !data.type) return;

    if (data.type === 'nt:ping') {
      window.parent.postMessage({ source: 'nt-dbot', type: 'nt:pong' }, '*');
      return;
    }

    if (data.type === 'nt:auth') {
      const { token, loginId, isVirtual, currency, balance } = data;
      log('Received auth:', { loginId, isVirtual, currency });
      try {
        if (token && loginId) {
          sessionStorage.setItem('auth_info', JSON.stringify({
            access_token: token,
            token_type: 'bearer',
            expires_in: 2592000,
            expires_at: Date.now() + 2592000000,
            scope: 'read trade'
          }));
          localStorage.setItem('authToken', token);
          localStorage.setItem('active_loginid', loginId);
          localStorage.setItem('account_type', isVirtual ? 'demo' : 'real');
          sessionStorage.setItem('deriv_accounts', JSON.stringify([{
            account_id: loginId,
            balance: String(balance ?? '10000.00'),
            currency: currency ?? 'USD',
            group: isVirtual ? 'demo' : 'real',
            status: 'active',
            account_type: isVirtual ? 'demo' : 'real'
          }]));
          localStorage.setItem('accountsList', JSON.stringify({ [loginId]: token }));
          localStorage.setItem('clientAccounts', JSON.stringify({
            [loginId]: { loginid: loginId, token: token, currency: currency ?? 'USD', is_virtual: isVirtual ? 1 : 0 }
          }));

          window.parent.postMessage({
            source: 'nt-dbot',
            type: 'nt:auth:ok',
            loginId: loginId,
            isVirtual: isVirtual
          }, '*');

          // If DBot API base is already running, reinitialize connection
          if (window.__DBOT_API_BASE__) {
            try {
              window.__DBOT_API_BASE__.init(true);
            } catch (err) {
              log('Error reinitializing api_base:', err);
            }
          }
        }
      } catch (err) {
        log('Error storing auth credentials:', err);
        window.parent.postMessage({
          source: 'nt-dbot',
          type: 'nt:auth:error',
          message: err ? err.message : 'Unknown auth error'
        }, '*');
      }
      return;
    }

    if (data.type === 'nt:load') {
      const { xml, name } = data;
      log('Received strategy to load:', name);
      if (!xml) return;

      const tryLoad = function(retries) {
        if (window.Blockly && window.Blockly.derivWorkspace) {
          try {
            const dom = window.Blockly.utils.xml.textToDom(xml);
            window.Blockly.derivWorkspace.asyncClear();
            window.Blockly.Xml.domToWorkspace(dom, window.Blockly.derivWorkspace);
            window.Blockly.derivWorkspace.cleanUp();
            const count = window.Blockly.derivWorkspace.getAllBlocks().length;
            log('Strategy loaded successfully, blocks:', count);
            window.parent.postMessage({
              source: 'nt-dbot',
              type: 'nt:loaded',
              blocks: count,
              name: name
            }, '*');
          } catch (e) {
            log('Error parsing/loading XML:', e);
            window.parent.postMessage({
              source: 'nt-dbot',
              type: 'nt:load:error',
              message: e ? e.message : 'Failed to load strategy into workspace'
            }, '*');
          }
        } else if (retries > 0) {
          setTimeout(function() { tryLoad(retries - 1); }, 300);
        } else {
          window.parent.postMessage({
            source: 'nt-dbot',
            type: 'nt:load:error',
            message: 'Blockly workspace timeout'
          }, '*');
        }
      };

      tryLoad(50);
      return;
    }
  });

  // Check workspace readiness and notify parent
  var readyPoller = setInterval(function() {
    if (window.Blockly && window.Blockly.derivWorkspace) {
      clearInterval(readyPoller);
      log('Blockly workspace is ready');
      if (isEmbedded) {
        window.parent.postMessage({ source: 'nt-dbot', type: 'nt:ready' }, '*');
      }
    }
  }, 250);

  // Monitor execution state
  var lastRunning = false;
  setInterval(function() {
    var isRunning = false;
    // Check various running indicators in Deriv Bot
    if (window.DBot && window.DBot.is_bot_running) {
      isRunning = true;
    } else if (document.querySelector('.bot-builder__stop-button') || document.querySelector('[data-testid="dt_stop_button"]')) {
      isRunning = true;
    }
    if (isRunning !== lastRunning) {
      lastRunning = isRunning;
      if (isEmbedded) {
        window.parent.postMessage({
          source: 'nt-dbot',
          type: isRunning ? 'nt:run' : 'nt:stop'
        }, '*');
      }
    }
  }, 500);

  log('Bridge script initialized');
})();
