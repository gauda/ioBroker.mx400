const assert = require('node:assert');
const {
    parseCorePaths,
    deriveStateId,
    toBool,
    energyDifference,
    extractRecordingPeriods,
    parseEmonValues,
    sanitizeSignalId,
    formatLocalDate,
    describeHttpError,
    getTypeForValue,
    getRoleForPath,
} = require('../build/lib/pure.js');

describe('pure helpers', () => {
    describe('parseCorePaths', () => {
        it('splits lines, trims, ignores blanks and comments and normalizes the leading slash', () => {
            const warnings = [];
            const result = parseCorePaths('  /a/b  \n\n# comment\nheatSources/x\n/y', w => warnings.push(w));
            assert.deepStrictEqual(result, ['/a/b', '/heatSources/x', '/y']);
            assert.strictEqual(warnings.length, 0);
        });

        it('warns about and ignores extra content on a line', () => {
            const warnings = [];
            const result = parseCorePaths('/a/b someStateId', w => warnings.push(w));
            assert.deepStrictEqual(result, ['/a/b']);
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0], /Ignoring extra text/);
        });

        it('returns an empty list for empty input', () => {
            assert.deepStrictEqual(parseCorePaths('', () => {}), []);
        });
    });

    describe('deriveStateId', () => {
        it('uses the first segment as channel and flattens the rest', () => {
            assert.strictEqual(
                deriveStateId('/system/sensors/temperatures/outdoor_t1'),
                'system.sensors_temperatures_outdoor_t1',
            );
        });

        it('collapses redundant leading slashes', () => {
            assert.strictEqual(deriveStateId('///a/b/c'), 'a.b_c');
        });

        it('replaces unsafe characters with underscores', () => {
            assert.strictEqual(deriveStateId('/a-b/c.d e'), 'a_b.c_d_e');
        });

        it('returns a single segment unchanged', () => {
            assert.strictEqual(deriveStateId('/brand'), 'brand');
        });

        it('falls back to custom.unknown for empty paths', () => {
            assert.strictEqual(deriveStateId('/'), 'custom.unknown');
            assert.strictEqual(deriveStateId(''), 'custom.unknown');
        });
    });

    describe('toBool', () => {
        it('returns the fallback for empty values', () => {
            assert.strictEqual(toBool(undefined, true), true);
            assert.strictEqual(toBool(null, false), false);
            assert.strictEqual(toBool('', true), true);
        });

        it('passes booleans through', () => {
            assert.strictEqual(toBool(true, false), true);
            assert.strictEqual(toBool(false, true), false);
        });

        it('parses strings case-insensitively', () => {
            assert.strictEqual(toBool('false', true), false);
            assert.strictEqual(toBool('FALSE', true), false);
            assert.strictEqual(toBool('true', false), true);
            assert.strictEqual(toBool('yes', false), true);
        });

        it('treats other values as true', () => {
            assert.strictEqual(toBool(0, false), true);
            assert.strictEqual(toBool(1, false), true);
        });
    });

    describe('energyDifference', () => {
        it('subtracts all parts', () => {
            assert.strictEqual(energyDifference(100, 30, 20), 50);
        });

        it('returns the total when there are no parts', () => {
            assert.strictEqual(energyDifference(100), 100);
        });

        it('returns undefined when a value is missing or not a number', () => {
            assert.strictEqual(energyDifference(undefined, 1), undefined);
            assert.strictEqual(energyDifference(100, 'x'), undefined);
            assert.strictEqual(energyDifference(100, undefined), undefined);
        });

        it('rounds away float noise', () => {
            assert.strictEqual(energyDifference(0.3, 0.1), 0.2);
            assert.strictEqual(energyDifference(1.23456, 0), 1.235);
        });
    });

    describe('extractRecordingPeriods', () => {
        it('reads the last daily and monthly point', () => {
            const data = {
                values: [
                    { sampleRate: 'P1D', recording: [{ y: 1 }, { y: 5 }] },
                    { sampleRate: 'P1M', recording: [{ y: 10 }, { y: 42 }] },
                ],
            };
            assert.deepStrictEqual(extractRecordingPeriods(data), { today: 5, month: 42 });
        });

        it('returns undefined for missing groups or points', () => {
            assert.deepStrictEqual(extractRecordingPeriods({ values: [{ sampleRate: 'P1D' }] }), {
                today: undefined,
                month: undefined,
            });
            assert.deepStrictEqual(extractRecordingPeriods(undefined), { today: undefined, month: undefined });
        });

        it('ignores non-numeric samples', () => {
            const data = { values: [{ sampleRate: 'P1D', recording: [{ y: 'x' }] }] };
            assert.strictEqual(extractRecordingPeriods(data).today, undefined);
        });
    });

    describe('parseEmonValues', () => {
        it('merges the single-key component objects', () => {
            const data = { values: [{ compressor: 1 }, { eheater: 2, ignored: 'x' }, { outputProduced: 3 }] };
            assert.deepStrictEqual(parseEmonValues(data), { compressor: 1, eheater: 2, outputProduced: 3 });
        });

        it('returns an empty map for invalid input', () => {
            assert.deepStrictEqual(parseEmonValues(undefined), {});
            assert.deepStrictEqual(parseEmonValues({ values: 'nope' }), {});
        });
    });

    describe('sanitizeSignalId', () => {
        it('strips the signals prefix and flattens the path', () => {
            assert.strictEqual(sanitizeSignalId('/signals/temperatures/outdoor'), 'temperatures_outdoor');
            assert.strictEqual(sanitizeSignalId('/signals/a-b'), 'a_b');
        });
    });

    describe('formatLocalDate', () => {
        it('formats as YYYY-MM-DD with zero padding', () => {
            assert.strictEqual(formatLocalDate(new Date(2024, 0, 5)), '2024-01-05');
            assert.strictEqual(formatLocalDate(new Date(2024, 11, 31)), '2024-12-31');
        });
    });

    describe('describeHttpError', () => {
        it('prefers the response body message', () => {
            const error = { response: { status: 400, data: { message: 'bad request' } } };
            assert.deepStrictEqual(describeHttpError(error), { status: 400, message: 'bad request' });
        });

        it('falls back to the body error field and status text', () => {
            assert.strictEqual(describeHttpError({ response: { status: 400, data: { error: 'oops' } } }).message, 'oops');
            assert.strictEqual(describeHttpError({ response: { status: 500, statusText: 'Server Error' } }).message, 'Server Error');
        });

        it('falls back to the HTTP status code name', () => {
            assert.strictEqual(describeHttpError({ response: { status: 404 } }).message, 'Not Found');
        });
    });

    describe('getTypeForValue', () => {
        it('maps primitive values to ioBroker types', () => {
            assert.strictEqual(getTypeForValue(true), 'boolean');
            assert.strictEqual(getTypeForValue(1), 'number');
            assert.strictEqual(getTypeForValue('x'), 'string');
            assert.strictEqual(getTypeForValue(null), 'mixed');
            assert.strictEqual(getTypeForValue({}), 'mixed');
        });
    });

    describe('getRoleForPath', () => {
        it('prefers the unit of measure', () => {
            assert.strictEqual(getRoleForPath('/any', 'C', 1), 'value.temperature');
            assert.strictEqual(getRoleForPath('/any', 'kW', 1), 'value.power');
            assert.strictEqual(getRoleForPath('/any', 'kWh', 1), 'value.energy');
            assert.strictEqual(getRoleForPath('/any', '%', 1), 'value');
        });

        it('falls back to path heuristics', () => {
            assert.strictEqual(getRoleForPath('/x/humidity', undefined, 1), 'value.humidity');
            assert.strictEqual(getRoleForPath('/x/actualTemperature', undefined, 1), 'value.temperature');
            assert.strictEqual(getRoleForPath('/x/powerElecActual', undefined, 1), 'value.power');
            assert.strictEqual(getRoleForPath('/x/actualModulation', undefined, 1), 'value');
            assert.strictEqual(getRoleForPath('/x/totalConsumption', undefined, 1), 'value.energy');
            assert.strictEqual(getRoleForPath('/gateway/versionFirmware', undefined, 'x'), 'text');
        });

        it('uses the value shape for status-like paths', () => {
            assert.strictEqual(getRoleForPath('/x/flameStatus', undefined, true), 'indicator');
            assert.strictEqual(getRoleForPath('/x/flameStatus', undefined, 'on'), 'text');
            assert.strictEqual(getRoleForPath('/x/unknown', undefined, false), 'indicator');
            assert.strictEqual(getRoleForPath('/x/unknown', undefined, 5), 'value');
        });
    });
});
