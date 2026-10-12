import * as utils from '@iobroker/adapter-core';
import axios, { AxiosInstance } from 'axios';
import { Agent } from 'https';
import { STATUS_CODES } from 'http';
import makeMdns from 'multicast-dns';

/** mDNS service advertised by the K40 RF gateway (see the official API guide). */
const MDNS_SERVICE = '_hvac-open-api._tcp.local';
/** How long to wait for an mDNS answer before giving up. */
const MDNS_TIMEOUT_MS = 4000;

interface Mx400Config {
	host: string;
	port: number;
	authPort: number;
	useMdns: boolean;
	login: string;
	password: string;
	accessToken: string;
	pollInterval: number;
	signalsInterval: number;
	signalsFilter: string;
	requestTimeout: number;
	acceptSelfSigned: boolean;
	corePaths: string;
	enableEnergy: boolean;
	energyInterval: number;
}

/** A curated resource from the core (fast) poll. */
interface CoreResource {
	path: string;
	stateId: string;
}

/**
 * Built-in core paths, used when the user has not configured "corePaths" yet
 * (e.g. an existing instance without the new native field).
 */
const DEFAULT_CORE_PATHS: string[] = [
	'/system/sensors/temperatures/outdoor_t1',
	'/heatSources/actualSupplyTemperature',
	'/heatSources/actualModulation',
	'/heatSources/currentSupplySetpoint',
	'/heatSources/returnTemperature',
	'/heatSources/flameStatus',
	'/heatSources/compressor/powerElecActual',
	'/heatSources/Source/eHeater/status',
	'/heatingCircuits/hc1/overallStatus',
	'/heatingCircuits/hc1/currentRoomSetpoint',
];

/**
 * Result of a single resource fetch:
 * - outcome 'ok': value read and stored
 * - outcome 'http': the gateway answered but rejected the path (e.g. HTTP 404)
 * - outcome 'transport': the gateway could not be reached (certificate rejected,
 *   host unreachable, timeout, connection reset)
 */
type FetchResult =
	| { outcome: 'ok' }
	| { outcome: 'http'; status: number; message: string }
	| { outcome: 'transport'; code: string; message: string };

/** A recording fetch plus the derived today/month periods. */
interface EnergyRecordingResponse {
	path: string;
	result: FetchResult;
	periods?: { today?: number; month?: number };
}

/** The emon totals fetch plus the parsed component map. */
interface EnergyOverallResponse {
	path: string;
	result: FetchResult;
	map?: Record<string, number>;
}

/** A gateway found via mDNS. */
interface DiscoveredGateway {
	/** Host usable in a URL (prefers the resolved IPv4 address). */
	host: string;
	address?: string;
	hostname?: string;
	port?: number;
}

/** Payload sent by the "Test connection" button in the admin UI. */
interface TestConnectionRequest {
	host?: string;
	port?: string | number;
	authPort?: string | number;
	useMdns?: string | boolean;
	acceptSelfSigned?: string | boolean;
	login?: string;
	password?: string;
	accessToken?: string;
	requestTimeout?: string | number;
}

class Mx400Adapter extends utils.Adapter {
	// config is available from parent
	private httpApi!: AxiosInstance;
	private httpAuth!: AxiosInstance;
	private token: string | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private signalsTimer: NodeJS.Timeout | null = null;
	private energyTimer: NodeJS.Timeout | null = null;
	/** State ids for which an object has already been created. */
	private knownStates = new Set<string>();

	/** Static identity resources, polled once at startup. */
	private readonly staticResources: CoreResource[] = [
		{ path: '/gateway/brand', stateId: 'gateway.brand' },
		{ path: '/gateway/versionFirmware', stateId: 'gateway.firmware' },
		{ path: '/gateway/versionHardware', stateId: 'gateway.hardware' },
	];

	/**
	 * Fast-moving core resources, polled every pollInterval. Configurable in
	 * the adapter settings ("corePaths"): one entry per line, "<path> [stateId]".
	 */
	private coreResources: CoreResource[] = [];

	/** Parse the user-edited core path list: one path per line, "#" marks comments. */
	private parseCorePaths(raw: string): string[] {
		const paths: string[] = [];
		for (const rawLine of String(raw || '').split('\n')) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#')) {
				continue;
			}
			const parts = line.split(/\s+/).filter(Boolean);
			if (parts.length > 1) {
				this.log.warn(
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
	 * Derive a state id from a path: the first path segment becomes the
	 * channel, all following segments are flattened with "_". E.g.
	 * /system/sensors/temperatures/outdoor_t1 -> system.sensors_temperatures_outdoor_t1
	 */
	private deriveStateId(path: string): string {
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

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: 'mx400',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.on('message', this.onMessage.bind(this));
	}

	private async onReady(): Promise<void> {
		// Load configuration
		this.config = this.config as unknown as Mx400Config;

		// Core path list is user-editable in the adapter settings. For existing
		// instances the new "corePaths" native field may not be saved yet - in
		// that case fall back to the built-in default list.
		const rawCorePaths = (this.config as any).corePaths;
		const corePaths =
			rawCorePaths === undefined || rawCorePaths === null
				? DEFAULT_CORE_PATHS
				: this.parseCorePaths(rawCorePaths);
		this.coreResources = corePaths.map(path => ({ path, stateId: this.deriveStateId(path) }));
		if (!this.coreResources.length) {
			this.log.warn('No core paths configured - only notifications will be polled.');
		}

		// Normalize possibly-string config values to a real boolean
		const rejectUnauthorized = this.effectiveRejectUnauthorized();
		this.log.debug(
			rejectUnauthorized
				? 'Certificate verification enabled - only trusted, publicly signed certificates are accepted.'
				: 'Certificate verification disabled - self-signed gateway certificates are accepted.',
		);

		// Resolve the gateway host - optionally via mDNS so the IP may change
		// without reconfiguring the adapter.
		const host = await this.resolveGatewayHost();

		// Initialize HTTP clients
		this.httpAuth = this.createAuthClient(host, (this.config as any).authPort, rejectUnauthorized);

		this.httpApi = this.createApiClient(host, (this.config as any).port, rejectUnauthorized);

		try {
			// Get token if not provided
			if ((this.config as any).accessToken) {
				this.token = (this.config as any).accessToken;
			} else if ((this.config as any).login && (this.config as any).password) {
				await this.authenticate();
			} else {
				this.log.error('No access token or login credentials provided. Please configure the adapter.');
				return;
			}

			// Set token for API client
			this.httpApi.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;

			// Static identity data - poll once at startup
			const reachable = await this.pollStatics();

			await this.setStateAsync('info.connection', reachable, true);

			// Start polling
			this.startPolling();
		} catch (error) {
			this.log.error(`Failed to initialize: ${error}`);
			await this.setStateAsync('info.connection', false, true);
		}
	}

	private createAuthClient(host: string, authPort: number, rejectUnauthorized: boolean): AxiosInstance {
		return axios.create({
			baseURL: `https://${host}:${authPort}`,
			httpsAgent: new Agent({ rejectUnauthorized }),
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			timeout: this.requestTimeout(),
		});
	}

	/**
	 * The user-facing setting is "Accept self-signed certificates"; Node's HTTPS
	 * agent needs rejectUnauthorized, which is the opposite. Missing value is
	 * treated as "accept" for backward compatibility. ioBroker may hand the
	 * value over as a boolean or a string - both are normalized here.
	 */
	private effectiveRejectUnauthorized(): boolean {
		const raw = (this.config as any).acceptSelfSigned;
		const accept = raw !== false && raw !== 'false';
		return !accept;
	}

	/** Whether mDNS discovery is enabled (the value may arrive as string or boolean). */
	private useMdnsEnabled(): boolean {
		const raw = (this.config as any).useMdns;
		return raw === true || raw === 'true';
	}

	/**
	 * Resolve the host used for HTTPS requests. With mDNS enabled the gateway is
	 * looked up on the local network first (its IP may change over time);
	 * otherwise - or if discovery finds nothing - the configured host is used.
	 */
	private async resolveGatewayHost(): Promise<string> {
		const configured = String((this.config as any).host || '').trim();
		if (!this.useMdnsEnabled()) {
			return configured;
		}
		const found = await this.discoverGateway();
		if (found) {
			this.log.info(
				`mDNS discovery found the gateway at ${found.host}${found.hostname ? ` (${found.hostname})` : ''}.`,
			);
			return found.host;
		}
		if (configured) {
			this.log.warn('mDNS discovery found no gateway - falling back to the configured host.');
		} else {
			this.log.error('mDNS discovery found no gateway and no host is configured.');
		}
		return configured;
	}

	/**
	 * Discover the K40 RF gateway through the mDNS service _hvac-open-api._tcp.
	 * Prefers the resolved IPv4 address (so no OS-level mDNS resolution is
	 * needed) and falls back to the SRV target hostname.
	 */
	private discoverGateway(timeoutMs = MDNS_TIMEOUT_MS): Promise<DiscoveredGateway | null> {
		return new Promise(resolve => {
			const normalize = (value: unknown): string => String(value).toLowerCase().replace(/\.$/, '');
			const service = normalize(MDNS_SERVICE);

			let settled = false;
			let instance: string | undefined;
			let target: string | undefined;
			let address: string | undefined;
			let port: number | undefined;
			let queriedSrv = false;
			let queriedA = false;
			let timer: NodeJS.Timeout | undefined;

			let mdns: makeMdns.MulticastDNS;
			try {
				mdns = makeMdns();
			} catch (error: any) {
				this.log.warn(`mDNS is not available: ${error?.message || error}`);
				resolve(null);
				return;
			}

			const finish = (result: DiscoveredGateway | null): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				try {
					mdns.destroy();
				} catch {
					// ignore teardown errors
				}
				resolve(result);
			};

			const handleRecords = (records: any[]): void => {
				// 1) Service instance (PTR) - _hvac-open-api._tcp.local -> <instance>._hvac-open-api._tcp.local
				for (const record of records) {
					if (record.type === 'PTR' && normalize(record.name) === service) {
						instance = normalize(record.data);
					}
				}
				// 2) Target host + port (SRV) for our instance
				if (instance) {
					for (const record of records) {
						if (record.type === 'SRV' && normalize(record.name) === instance) {
							target = normalize(record.data.target);
							port = record.data.port;
						}
					}
				}
				// 3) IPv4 address (A) for the target
				if (target) {
					for (const record of records) {
						if (record.type === 'A' && normalize(record.name) === target) {
							address = record.data;
						}
					}
				}

				if (address) {
					finish({ host: address, address, hostname: target, port });
					return;
				}
				// Ask follow-up questions if the responder did not bundle the records.
				if (instance && !target && !queriedSrv) {
					queriedSrv = true;
					mdns.query([{ name: instance, type: 'SRV' }]);
				} else if (target && !address && !queriedA) {
					queriedA = true;
					mdns.query([{ name: target, type: 'A' }]);
				}
			};

			mdns.on('response', response => {
				handleRecords([...(response.answers || []), ...(response.additionals || [])] as any[]);
			});

			mdns.on('error', () => finish(null));

			mdns.query([{ name: MDNS_SERVICE, type: 'PTR' }]);

			timer = setTimeout(() => {
				// No A record came back - fall back to the SRV target hostname.
				finish(target ? { host: target, hostname: target, port } : null);
			}, timeoutMs);
		});
	}

	/** Handle sendTo() requests from the admin UI. */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		if (!obj || !obj.command) {
			return;
		}
		if (obj.command === 'testConnection') {
			let response: Record<string, any>;
			try {
				response = await this.testConnection((obj.message || {}) as TestConnectionRequest);
			} catch (error: any) {
				response = { error: error?.message || String(error) };
			}
			this.sendTo(obj.from, obj.command, response, obj.callback);
		} else {
			this.sendTo(obj.from, obj.command, { error: `Unknown command: ${obj.command}` }, obj.callback);
		}
	}

	/**
	 * Test the connection with the (possibly unsaved) values from the admin
	 * form. Returns either { result } on success - optionally with a discovered
	 * host to store - or { error } on failure.
	 */
	private async testConnection(request: TestConnectionRequest): Promise<Record<string, any>> {
		const useMdns = Mx400Adapter.toBool(request.useMdns, false);
		const acceptSelfSigned = Mx400Adapter.toBool(request.acceptSelfSigned, true);
		const rejectUnauthorized = !acceptSelfSigned;
		const authPort = Number(request.authPort) || 9442;
		const apiPort = Number(request.port) || 9443;
		const timeout = Number(request.requestTimeout) || 15000;
		const login = String(request.login || '');
		const password = String(request.password || '');
		const accessToken = String(request.accessToken || '');
		const configuredHost = String(request.host || '').trim();

		let host = configuredHost;
		let discovered: DiscoveredGateway | null = null;
		if (useMdns) {
			discovered = await this.discoverGateway();
			if (discovered) {
				host = discovered.host;
			}
		}
		if (!host) {
			return {
				error: useMdns
					? 'No gateway found via mDNS and no host configured.'
					: 'No gateway host configured.',
			};
		}

		const auth = axios.create({
			baseURL: `https://${host}:${authPort}`,
			httpsAgent: new Agent({ rejectUnauthorized }),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			timeout,
		});
		const api = axios.create({
			baseURL: `https://${host}:${apiPort}`,
			httpsAgent: new Agent({ rejectUnauthorized }),
			timeout,
		});

		let status: number | null = null;
		try {
			let token = accessToken;
			if (!token) {
				if (!login || !password) {
					return { error: 'Provide login and password, or a pre-generated access token.' };
				}
				token = await this.requestToken(auth, login, password);
			}
			api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
			await api.get('/gateway/versionFirmware');
			status = 200;
		} catch (error: any) {
			const httpStatus = error?.response?.status;
			if (httpStatus === 412) {
				return {
					error: 'Physical proximity not proven. Press WLAN and Wireless buttons simultaneously for 1 second, then retry within 5 minutes.',
				};
			}
			if (httpStatus === 401 || httpStatus === 403) {
				return { error: `Authentication failed (HTTP ${httpStatus}). Check login/password or the access token.` };
			}
			if (!httpStatus) {
				const code = error?.code ? `${error.code}: ` : '';
				return { error: `Cannot reach the gateway at ${host}. ${code}${error?.message || error}` };
			}
			// Any HTTP answer means the transport (and certificate handling) work.
			status = httpStatus;
		}

		const response: Record<string, any> = {
			result:
				status === 200
					? `Connection successful (${host}).`
					: `Gateway ${host} is reachable (HTTP ${status}).`,
		};
		if (discovered && discovered.host !== configuredHost) {
			// Let the button write the discovered address into the host field.
			response.native = { host: discovered.host };
			response.saveConfig = true;
		}
		return response;
	}

	/** Normalize a boolean that may arrive as a string from the admin UI. */
	private static toBool(value: unknown, fallback: boolean): boolean {
		if (value === undefined || value === null || value === '') {
			return fallback;
		}
		if (typeof value === 'boolean') {
			return value;
		}
		return String(value).toLowerCase() !== 'false';
	}

	private createApiClient(host: string, port: number, rejectUnauthorized: boolean, token?: string): AxiosInstance {
		const client = axios.create({
			baseURL: `https://${host}:${port}`,
			httpsAgent: new Agent({ rejectUnauthorized }),
			timeout: this.requestTimeout(),
		});
		if (token) {
			client.defaults.headers.common['Authorization'] = `Bearer ${token}`;
		}
		return client;
	}

	private async requestToken(authClient: AxiosInstance, login: string, password: string): Promise<string> {
		// Remove hyphens from password as per API docs
		const params = new URLSearchParams();
		params.append('grant_type', 'password');
		params.append('username', login);
		params.append('password', String(password).replace(/-/g, ''));
		params.append('client_name', 'ioBroker.mx400');

		const response = await authClient.post('/auth/token', params);
		return response.data.access_token;
	}

	private async authenticate(): Promise<void> {
		try {
			this.token = await this.requestToken(
				this.httpAuth,
				(this.config as any).login,
				(this.config as any).password,
			);
			this.log.info('Authentication successful');
		} catch (error: any) {
			if (error.response?.status === 412) {
				this.log.error('Physical proximity not proven. Press WLAN and Wireless buttons simultaneously for 1 second, then retry within 5 minutes.');
			} else {
				this.log.error(`Authentication failed: ${error.message}`);
			}
			throw error;
		}
	}

	private startPolling(): void {
		this.stopTimers();

		const pollInterval = (Number((this.config as any).pollInterval) || 60) * 1000;
		this.pollTimer = setInterval(() => {
			void this.poll();
		}, pollInterval);
		void this.poll();

		// Discovered signals (slow tier) - driven by the filter regex only
		const hasFilter = String((this.config as any).signalsFilter || '').trim().length > 0;
		if (hasFilter) {
			const signalsInterval = (Number((this.config as any).signalsInterval) || 300) * 1000;
			this.signalsTimer = setInterval(() => {
				void this.pollSignals();
			}, signalsInterval);
			void this.pollSignals();
		}

		// Energy monitoring (slow tier) - optional, heavier recording requests
		if (this.energyEnabled()) {
			const energyInterval = (Number((this.config as any).energyInterval) || 3600) * 1000;
			this.energyTimer = setInterval(() => {
				void this.pollEnergy();
			}, energyInterval);
			void this.pollEnergy();
		}
	}

	/** Static identity resources - polled once at startup. Returns whether the gateway was reachable. */
	private async pollStatics(): Promise<boolean> {
		const results = await Promise.allSettled(
			this.staticResources.map(r => this.fetchAndSet(r.path, r.stateId)),
		);

		const transportFailures = this.logPollFailures(
			'Static',
			results,
			this.staticResources.map(r => r.path),
		);
		return transportFailures === 0;
	}

	/**
	 * Log one error line per failing endpoint, then return the number of
	 * transport-level failures (gateway unreachable).
	 */
	private logPollFailures(
		tier: string,
		results: PromiseSettledResult<FetchResult>[],
		paths: string[],
	): number {
		let transportFailures = 0;
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.status === 'fulfilled') {
				const outcome = result.value;
				if (outcome.outcome === 'ok') {
					continue;
				}
				if (outcome.outcome === 'transport') {
					transportFailures++;
				}
				this.logFailure(tier, paths[i], outcome);
			} else {
				// The fetch functions never reject, but stay safe.
				transportFailures++;
				this.log.error(
					`${tier} poll failed with ERR: ${paths[i]} returns ${(result.reason as Error)?.message || result.reason}`,
				);
			}
		}
		return transportFailures;
	}

	/** "<tier> poll failed with <code>: <path> returns <message>" */
	private logFailure(
		tier: string,
		path: string,
		result: Exclude<FetchResult, { outcome: 'ok' }>,
	): void {
		const code = result.outcome === 'http' ? result.status : result.code;
		this.log.error(`${tier} poll failed with ${code}: ${path} returns ${result.message}`);
	}

	/** Best-effort HTTP error description from the gateway response body or the status text. */
	private describeHttpError(error: any): { status: number; message: string } {
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

	private async poll(): Promise<void> {
		try {
			// Curated core resources, fetched in parallel
			const items = this.coreResources.map(r => ({
				path: r.path,
				task: this.fetchAndSet(r.path, r.stateId),
			}));
			// Notifications are handled separately because of their array shape
			items.push({ path: '/notifications', task: this.fetchNotifications() });

			const results = await Promise.allSettled(items.map(item => item.task));

			const transportFailures = this.logPollFailures(
				'Core',
				results,
				items.map(item => item.path),
			);
			await this.setStateAsync('info.connection', transportFailures === 0, true);
		} catch (error: any) {
			this.log.error(`Polling failed: ${error.message}`);
			await this.setStateAsync('info.connection', false, true);
		}
	}

	/** Handle /notifications which returns an error list rather than a scalar value. */
	private async fetchNotifications(): Promise<FetchResult> {
		try {
			const response = await this.httpApi.get('/notifications');
			const values = response.data?.values;

			const list = Array.isArray(values) ? values : [];

			await this.ensureObject('notifications', {
				name: 'Notifications',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			});
			await this.ensureObject('notifications.count', {
				name: 'Active notifications',
				type: 'number',
				role: 'value',
				read: true,
				write: false,
			});

			await this.setStateAsync('notifications', JSON.stringify(list), true);
			await this.setStateAsync('notifications.count', list.length, true);

			this.log.debug(`Polled /notifications -> ${JSON.stringify(list)}`);
			return { outcome: 'ok' };
		} catch (error: any) {
			const status = error?.response?.status;
			if (status) {
				this.log.debug(`Failed to fetch /notifications: HTTP ${status}`);
				return { outcome: 'http', ...this.describeHttpError(error) };
			}
			this.log.debug(`Failed to fetch /notifications: ${error?.message || error}`);
			return {
				outcome: 'transport',
				code: error?.code || 'ERR',
				message: error?.message || String(error),
			};
		}
	}

	/**
	 * Discover available appliance signals via /signals and read their current
	 * values. The list is system-dependent, so this adapts to the connected
	 * appliance automatically.
	 */
	private async pollSignals(): Promise<void> {
		// An empty filter means "read no signals". This keeps the request burst
		// against the gateway under explicit control - use ".*" to read all.
		const rawFilter = String((this.config as any).signalsFilter || '').trim();
		if (!rawFilter) {
			this.log.debug('Signals filter is empty; no signals will be polled. Set a filter (e.g. ".*") to read signals.');
			return;
		}

		let filter: RegExp;
		try {
			filter = new RegExp(rawFilter);
		} catch (error) {
			this.log.warn(`Invalid signalsFilter regular expression ignored: ${rawFilter}`);
			return;
		}

		try {
			const listResponse = await this.httpApi.get('/signals');
			const references = listResponse.data?.references;
			if (!Array.isArray(references)) {
				this.log.debug('No signal references returned by /signals');
				return;
			}

			const signalIds = references
				.map((ref: any) => ref?.id)
				.filter((id: unknown): id is string => typeof id === 'string' && id.startsWith('/signals/'))
				.filter((id: string) => filter.test(id));

			if (!signalIds.length) {
				this.log.debug('No signals matched the configured filter');
				return;
			}

			const tasks = signalIds.map((id: string) =>
				this.fetchAndSet(id, `signals.${this.sanitizeSignalId(id)}`),
			);
			const results = await this.allSettledLimited(tasks, 3);

			const transportFailures = this.logPollFailures('Signal', results, signalIds);
			if (transportFailures) {
				await this.setStateAsync('info.connection', false, true);
			}
		} catch (error: any) {
			const status = error?.response?.status;
			if (status) {
				const { message } = this.describeHttpError(error);
				this.log.error(`Signal poll failed with ${status}: /signals returns ${message}`);
			} else {
				this.log.error(
					`Signal poll failed with ${error?.code || 'ERR'}: /signals returns ${error?.message || error}`,
				);
				await this.setStateAsync('info.connection', false, true);
			}
		}
	}

	/** Energy monitoring is opt-out: enabled unless explicitly switched off. */
	private energyEnabled(): boolean {
		const raw = (this.config as any).enableEnergy;
		return raw !== false && raw !== 'false';
	}

	private formatLocalDate(date: Date): string {
		const pad = (n: number): string => String(n).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	}

	/**
	 * Energy monitoring: cumulative totals from /heatSources/emon/totalConsumption
	 * ("overall") plus today/month values derived from the recordings API.
	 *
	 * The gateway exposes no dedicated "environmental energy" value, so the
	 * created (produced) heat is split into the heat-pump share (its electrical
	 * input, i.e. the compressor consumption) and the environmental share (the
	 * free heat drawn from the environment, = produced heat - compressor input
	 * - electric heater input).
	 */
	private async pollEnergy(): Promise<void> {
		const now = new Date();
		const today = this.formatLocalDate(now);
		const monthStart = this.formatLocalDate(new Date(now.getFullYear(), now.getMonth(), 1));
		const query = `?sampleRate=all&startDate=${monthStart}&endDate=${today}`;
		const base = '/recordings/heatSources/emon';

		const [overall, compressor, eheater, produced] = await Promise.all([
			this.loadEnergyOverall(),
			this.loadEnergyRecording(`${base}/total/compressor`, query),
			this.loadEnergyRecording(`${base}/total/eheater`, query),
			this.loadEnergyRecording(`${base}/total/outputProduced`, query),
		]);

		// One error line per failing endpoint
		for (const response of [overall, compressor, eheater, produced]) {
			if (response.result.outcome !== 'ok') {
				this.logFailure('Energy', response.path, response.result);
			}
		}

		// Overall (cumulative) values
		const map = overall.map || {};
		await this.setEnergyState('energy.used.overall.heatpump', 'Heat pump consumption (overall)', map.compressor);
		await this.setEnergyState('energy.used.overall.eheater', 'Electric heater consumption (overall)', map.eheater);
		await this.setEnergyState('energy.used.overall.total', 'Electricity consumption (overall)', map.electricity);
		await this.setEnergyState('energy.created.overall.heatpump', 'Heat from heat pump (overall)', map.compressor);
		await this.setEnergyState(
			'energy.created.overall.environment',
			'Heat from environment (overall)',
			this.energyDifference(map.outputProduced, map.compressor, map.eheater),
		);

		// Today / this month values
		const c = compressor.periods || {};
		const e = eheater.periods || {};
		const out = produced.periods || {};

		await this.setEnergyState('energy.used.today.heatpump', 'Heat pump consumption (today)', c.today);
		await this.setEnergyState('energy.used.month.heatpump', 'Heat pump consumption (this month)', c.month);
		await this.setEnergyState('energy.used.today.eheater', 'Electric heater consumption (today)', e.today);
		await this.setEnergyState('energy.used.month.eheater', 'Electric heater consumption (this month)', e.month);

		await this.setEnergyState('energy.created.today.heatpump', 'Heat from heat pump (today)', c.today);
		await this.setEnergyState('energy.created.month.heatpump', 'Heat from heat pump (this month)', c.month);
		await this.setEnergyState(
			'energy.created.today.environment',
			'Heat from environment (today)',
			this.energyDifference(out.today, c.today, e.today),
		);
		await this.setEnergyState(
			'energy.created.month.environment',
			'Heat from environment (this month)',
			this.energyDifference(out.month, c.month, e.month),
		);
	}

	/** Cumulative (overall) emon totals, split by component. */
	private async loadEnergyOverall(): Promise<EnergyOverallResponse> {
		const path = '/heatSources/emon/totalConsumption';
		try {
			const response = await this.httpApi.get(path);
			const map = this.parseEmonValues(response.data);
			this.log.debug(`Polled ${path} -> ${JSON.stringify(map)}`);
			return { path, result: { outcome: 'ok' }, map };
		} catch (error: any) {
			return { path, result: this.fetchError(path, error) };
		}
	}

	/**
	 * Read a cumulative recording (full resource path, e.g.
	 * /recordings/heatSources/emon/total/compressor) and derive "today" (last
	 * daily point) and "this month" (monthly point) values.
	 */
	private async loadEnergyRecording(resourcePath: string, query: string): Promise<EnergyRecordingResponse> {
		const path = `${resourcePath}${query}`;
		try {
			const response = await this.httpApi.get(path);
			const periods = this.extractRecordingPeriods(response.data);
			this.log.debug(`Polled ${path} -> today=${periods.today}, month=${periods.month}`);
			return { path, result: { outcome: 'ok' }, periods };
		} catch (error: any) {
			return { path, result: this.fetchError(path, error) };
		}
	}

	/** produced - consumed parts, guarded against missing values and float noise. */
	private energyDifference(total: unknown, ...parts: unknown[]): number | undefined {
		if (typeof total !== 'number' || parts.some(part => typeof part !== 'number')) {
			return undefined;
		}
		const sum = (parts as number[]).reduce((acc, part) => acc + part, 0);
		return Math.round((total - sum) * 1000) / 1000;
	}

	/** Last daily ('P1D') and monthly ('P1M') yield values from a recording response. */
	private extractRecordingPeriods(data: any): { today?: number; month?: number } {
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

	/** Merge the emonValue "values" array (one single-key object per component). */
	private parseEmonValues(data: any): Record<string, number> {
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

	private async setEnergyState(stateId: string, name: string, value: unknown): Promise<void> {
		if (typeof value !== 'number') {
			this.log.debug(`No value for ${stateId} (${name})`);
			return;
		}
		await this.ensureObject(stateId, {
			name,
			type: 'number',
			role: 'value.energy',
			read: true,
			write: false,
			unit: 'kWh',
		});
		await this.setStateAsync(stateId, value, true);
	}

	/** Shared error mapping for the energy fetches. */
	private fetchError(path: string, error: any): FetchResult {
		const status = error?.response?.status;
		if (status) {
			this.log.debug(`Failed to fetch ${path}: HTTP ${status}`);
			return { outcome: 'http', ...this.describeHttpError(error) };
		}
		this.log.debug(`Failed to fetch ${path}: ${error?.message || error}`);
		return {
			outcome: 'transport',
			code: error?.code || 'ERR',
			message: error?.message || String(error),
		};
	}

	private sanitizeSignalId(path: string): string {
		return path.replace(/^\/signals\//, '').replace(/[^A-Za-z0-9_]/g, '_');
	}

	private requestTimeout(): number {
		const timeout = Number((this.config as any).requestTimeout);
		return timeout > 0 ? timeout : 15000;
	}

	/**
	 * Resolve promises with a maximum number of concurrent tasks. Keeps the
	 * request burst against the gateway bounded when many signals are present.
	 */
	private async allSettledLimited<T>(tasks: Promise<T>[], limit: number): Promise<PromiseSettledResult<T>[]> {
		const results: PromiseSettledResult<T>[] = new Array(tasks.length);
		let index = 0;

		const worker = async (): Promise<void> => {
			while (index < tasks.length) {
				const current = index++;
				try {
					results[current] = { status: 'fulfilled', value: await tasks[current] };
				} catch (reason) {
					results[current] = { status: 'rejected', reason };
				}
			}
		};

		const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
		await Promise.all(workers);
		return results;
	}

	private async fetchAndSet(path: string, stateId: string): Promise<FetchResult> {
		try {
			const response = await this.httpApi.get(path);
			const data = response.data;

			if (data && typeof data.value !== 'undefined') {
				const unit = data.unitOfMeasure || undefined;

				await this.ensureObject(stateId, {
					name: this.stateNameFor(path, stateId),
					type: this.getTypeForValue(data.value),
					role: this.getRoleForPath(path, unit, data.value),
					read: true,
					write: false,
					unit,
				});

				await this.setStateAsync(stateId, data.value, true);
				this.log.debug(`Polled ${path} -> ${stateId} = ${JSON.stringify(data.value)}`);
				return { outcome: 'ok' };
			}
			this.log.debug(`Fetched ${path} but response contained no value`);
			return { outcome: 'http', status: response.status || 200, message: 'response contained no value' };
		} catch (error: any) {
			const status = error?.response?.status;

			if (status) {
				// The gateway answered but rejected the path (e.g. 404).
				// Detail stays at debug level - one error line per failing
				// endpoint is logged by the pollers.
				this.log.debug(`Failed to fetch ${path}: HTTP ${status}`);
				return { outcome: 'http', ...this.describeHttpError(error) };
			}

			// Transport-level failure: wrong certificate, host unreachable,
			// timeout, connection reset.
			this.log.debug(`Failed to fetch ${path}: ${error?.message || error}`);
			return {
				outcome: 'transport',
				code: error?.code || 'ERR',
				message: error?.message || String(error),
			};
		}
	}

	private async ensureObject(stateId: string, common: ioBroker.StateCommon): Promise<void> {
		if (this.knownStates.has(stateId)) {
			return;
		}
		await this.extendObjectAsync(stateId, {
			type: 'state',
			common,
			native: {},
		});
		this.knownStates.add(stateId);
	}

	private stateNameFor(path: string, stateId: string): string {
		if (path.startsWith('/signals/')) {
			return path.replace(/^\/signals\//, '');
		}
		return stateId;
	}

	private getTypeForValue(value: any): ioBroker.CommonType {
		if (typeof value === 'boolean') return 'boolean';
		if (typeof value === 'number') return 'number';
		if (typeof value === 'string') return 'string';
		return 'mixed';
	}

	private getRoleForPath(path: string, unit: string | undefined, value: unknown): string {
		// Prefer the unit of measure when available, it is the most reliable hint
		if (unit === 'C') return 'value.temperature';
		if (unit === 'W' || unit === 'kW') return 'value.power';
		if (unit === 'kWh') return 'value.energy';
		if (unit === '%') return 'value';

		if (/humidity/i.test(path)) return 'value.humidity';
		if (/temperature|temp/i.test(path)) return 'value.temperature';
		if (/power/i.test(path)) return 'value.power';
		if (/modulation/i.test(path)) return 'value';
		if (/energy|consumption/i.test(path)) return 'value.energy';
		if (/brand|firmware|hardware|version|name|type/i.test(path)) return 'text';

		if (typeof value === 'boolean') return 'indicator';
		if (/status|state|active|flame|detection|connected/i.test(path)) {
			return typeof value === 'string' ? 'text' : 'indicator';
		}
		return 'value';
	}

	private stopTimers(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.signalsTimer) {
			clearInterval(this.signalsTimer);
			this.signalsTimer = null;
		}
		if (this.energyTimer) {
			clearInterval(this.energyTimer);
			this.energyTimer = null;
		}
	}

	private onUnload(callback: () => void): void {
		this.stopTimers();
		this.setStateAsync('info.connection', false, true);
		callback();
	}
}

if (require.main === module) {
	// Start the adapter
	new Mx400Adapter();
} else {
	// Export for module system
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Mx400Adapter(options);
}
