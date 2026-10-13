const path = require('path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');

const ADAPTER_DIR = path.join(__dirname, '..');
const REPLY_TIMEOUT_MS = 15000;

/**
 * Send a command to the adapter and resolve with its reply.
 *
 * `harness.sendTo` resolves with the first change of the shared `messagebox`
 * state, which may be an intermediate/echo update without a response. Instead,
 * listen for mailbox state changes and only accept a reply-shaped message.
 *
 * @param harness The test harness of the running adapter
 * @param command The command to send
 * @param message The command payload
 */
function sendCommand(harness, command, message) {
    return new Promise((resolve, reject) => {
        const handler = (id, state) => {
            if (!String(id).startsWith('messagebox.')) {
                return;
            }
            const reply = state && state.message;
            if (reply && (reply.error !== undefined || reply.result !== undefined)) {
                clearTimeout(timer);
                harness.removeListener('stateChange', handler);
                resolve(reply);
            }
        };
        const timer = setTimeout(() => {
            harness.removeListener('stateChange', handler);
            reject(new Error(`Timed out after ${REPLY_TIMEOUT_MS}ms waiting for a reply to "${command}"`));
        }, REPLY_TIMEOUT_MS);

        harness.on('stateChange', handler);
        harness.sendTo(`${harness.adapterName}.0`, command, message, () => {});
    });
}

tests.integration(ADAPTER_DIR, {
    defineAdditionalTests({ suite }) {
        // One suite per scenario: the framework resets the DB and starts a fresh
        // adapter for each suite, so there is exactly one command per adapter run.
        function testConnectionCase(title, message, pattern) {
            suite(`testConnection: ${title}`, getHarness => {
                let harness;

                before(async () => {
                    harness = getHarness();
                    await harness.startAdapterAndWait();
                });

                it(title, async () => {
                    const response = await sendCommand(harness, 'testConnection', message);
                    assert.match(response.error, pattern);
                });
            });
        }

        testConnectionCase('reports a missing host', {}, /No gateway host configured/);

        testConnectionCase(
            'reports missing credentials',
            { host: '127.0.0.1', authPort: 9442, port: 9443 },
            /Provide login and password/,
        );

        // An out-of-range port makes axios reject the URL before any socket is
        // opened (ERR_INVALID_URL), which exercises the "cannot reach" branch
        // without attempting a real connection.
        testConnectionCase(
            'reports an unreachable gateway',
            { host: '127.0.0.1', port: 99999, accessToken: 'dummy-token', requestTimeout: 2000 },
            /Cannot reach the gateway/,
        );

        suite('Adapter without credentials', getHarness => {
            let harness;

            before(async () => {
                harness = getHarness();
                await harness.startAdapterAndWait();
            });

            it('starts and logs that credentials are missing', () => {
                assert.ok(
                    harness.hasLog(/No access token or login credentials/, 'error'),
                    'expected an error log about missing credentials',
                );
            });

            it('does not report an active connection', async () => {
                const state = await harness.states.getStateAsync(`${harness.adapterName}.0.info.connection`);
                assert.ok(
                    state === null || state === undefined || state.val === false,
                    `expected info.connection to stay inactive, got ${JSON.stringify(state)}`,
                );
            });
        });

        suite('testConnection: rejects unknown commands', getHarness => {
            let harness;

            before(async () => {
                harness = getHarness();
                await harness.startAdapterAndWait();
            });

            it('rejects unknown commands', async () => {
                const response = await sendCommand(harness, 'definitelyNotACommand', {});
                assert.match(response.error, /Unknown command/);
            });
        });
    },
});
