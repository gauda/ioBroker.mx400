import { STATUS_CODES } from 'http';

/**
 * Parse the user-edited core path list: one path per line, "#" marks comments.
 *
 * @param raw The raw, possibly multi-line core path list
 * @param warn Callback used to report lines with unexpected extra content
 */
export function parseCorePaths(raw: string, warn: (message: string) => void): string[] {
	const paths: string[] = [];
	for (const rawLine of String(raw || '').split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const parts = line.split(/\s+/).filter(Boolean);
		if (parts.length > 1) {
			warn(
				`Ignoring extra text on core path line "${line}" - state ids are derived from the path automatically.`,
			);
		}
		const path = parts[0];
		if (path) {
			// Normalize: API paths always start with a slash
			paths.push(path.startsWith('/') ? path : `/${path}`);
		}
	}
	return paths;
}

/**
 * Derive a state id from a path: the first path segment becomes the channel,
 * all following segments are flattened with "_". E.g.
 * /system/sensors/temperatures/outdoor_t1 -> system.sensors_temperatures_outdoor_t1
 *
 * @param path The gateway resource path
 */
export function deriveStateId(path: string): string {
	const segments = path
		.replace(/^\/+/, '')
		.split('/')
		.filter(Boolean)
		.map(s => s.replace(/[^A-Za-z0-9_]/g, '_'));
	if (!segments.length) {
		return 'custom.unknown';
	}
	const [channel, ...leaf] = segments;
	return leaf.length ? `${channel}.${leaf.join('_')}` : channel;
}

/**
 * Normalize a boolean that may arrive as a string from the admin UI.
 *
 * @param value The raw value to normalize
 * @param fallback The value to return when the input is empty
 */
export function toBool(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		return value.toLowerCase() !== 'false';
	}
	return true;
}

/**
 * produced - consumed parts, guarded against missing values and float noise.
 *
 * @param total The produced (output) value
 * @param parts The consumed input values to subtract
 */
export function energyDifference(total: unknown, ...parts: unknown[]): number | undefined {
	if (typeof total !== 'number' || parts.some(part => typeof part !== 'number')) {
		return undefined;
	}
	const sum = (parts as number[]).reduce((acc, part) => acc + part, 0);
	return Math.round((total - sum) * 1000) / 1000;
}

/**
 * Last daily ('P1D') and monthly ('P1M') yield values from a recording response.
 *
 * @param data The recording response body
 */
export function extractRecordingPeriods(data: any): { today?: number; month?: number } {
	const groups: any[] = Array.isArray(data?.values) ? data.values : [];

	const lastYield = (sampleRate: string): number | undefined => {
		const group = groups.find(g => g?.sampleRate === sampleRate);
		const points = Array.isArray(group?.recording) ? group.recording : [];
		if (!points.length) {
			return undefined;
		}
		const last = points[points.length - 1];
		return typeof last?.y === 'number' ? last.y : undefined;
	};

	return { today: lastYield('P1D'), month: lastYield('P1M') };
}

/**
 * Merge the emonValue "values" array (one single-key object per component).
 *
 * @param data The emonValue response body
 */
export function parseEmonValues(data: any): Record<string, number> {
	const map: Record<string, number> = {};
	if (Array.isArray(data?.values)) {
		for (const entry of data.values) {
			if (entry && typeof entry === 'object') {
				for (const [key, value] of Object.entries(entry)) {
					if (typeof value === 'number') {
						map[key] = value;
					}
				}
			}
		}
	}
	return map;
}

/**
 * Turn a /signals/ path into a safe state id segment.
 *
 * @param path The signal resource path
 */
export function sanitizeSignalId(path: string): string {
	return path.replace(/^\/signals\//, '').replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Format a date as YYYY-MM-DD in local time.
 *
 * @param date The date to format
 */
export function formatLocalDate(date: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Best-effort HTTP error description from the gateway response body or the status text.
 *
 * @param error The error thrown by the HTTP request
 */
export function describeHttpError(error: any): { status: number; message: string } {
	const status = error?.response?.status;
	return {
		status,
		message:
			error?.response?.data?.message ||
			error?.response?.data?.error ||
			error?.response?.statusText ||
			STATUS_CODES[status] ||
			`HTTP ${status}`,
	};
}

/**
 * Determine the ioBroker state type for a raw value.
 *
 * @param value The raw value read from the gateway
 */
export function getTypeForValue(value: any): ioBroker.CommonType {
	if (typeof value === 'boolean') {
		return 'boolean';
	}
	if (typeof value === 'number') {
		return 'number';
	}
	if (typeof value === 'string') {
		return 'string';
	}
	return 'mixed';
}

/**
 * Pick a sensible ioBroker role for a value, preferring the unit of measure.
 *
 * @param path The resource path (used as a fallback heuristic)
 * @param unit The unit of measure, if the gateway reported one
 * @param value The raw value, if available
 */
export function getRoleForPath(path: string, unit: string | undefined, value: unknown): string {
	// Prefer the unit of measure when available, it is the most reliable hint
	if (unit === 'C') {
		return 'value.temperature';
	}
	if (unit === 'W' || unit === 'kW') {
		return 'value.power';
	}
	if (unit === 'kWh') {
		return 'value.energy';
	}
	if (unit === '%') {
		return 'value';
	}

	if (/humidity/i.test(path)) {
		return 'value.humidity';
	}
	if (/temperature|temp/i.test(path)) {
		return 'value.temperature';
	}
	if (/power/i.test(path)) {
		return 'value.power';
	}
	if (/modulation/i.test(path)) {
		return 'value';
	}
	if (/energy|consumption/i.test(path)) {
		return 'value.energy';
	}
	if (/brand|firmware|hardware|version|name|type/i.test(path)) {
		return 'text';
	}

	if (typeof value === 'boolean') {
		return 'indicator';
	}
	if (/status|state|active|flame|detection|connected/i.test(path)) {
		return typeof value === 'string' ? 'text' : 'indicator';
	}
	return 'value';
}
