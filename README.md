# ioBroker.mx400

[![NPM version](https://img.shields.io/npm/v/iobroker.mx400.svg)](https://www.npmjs.com/package/iobroker.mx400)
[![Downloads](https://img.shields.io/npm/dm/iobroker.mx400.svg)](https://www.npmjs.com/package/iobroker.mx400)

ioBroker adapter for Buderus MX400 (K40 RF gateway) to control and monitor heating system.

## Features

- Reads data from Buderus MX400 / K40 RF gateway over local network
- Supports authentication with login/password (requires physical button press on gateway) or pre-generated access token
- Core monitoring set: outdoor temperature, supply/return temperatures, setpoint, modulation, compressor power, additional heater (Zuheizer) status, flame status, heating circuit status and room setpoint
- Notifications / error messages (`notifications` JSON state plus an active count)
- Automatic discovery of appliance-specific signals via `/signals`, filtered with a regular expression
- Energy monitoring (optional): consumed energy split by heat pump, electric heater and total, plus generated heat split into heat-pump and environmental share - as today, this month and overall values
- Configurable polling intervals and request timeout
- Automatic token management

## Object tree

- `gateway.*` - brand, firmware, hardware (polled once at startup)
- `system.sensors_temperatures_outdoor_t1` - outdoor temperature
- `heatSources.*` - supply/return temperature, setpoint, modulation, flame status,
  `compressor_powerElecActual` (compressor power) and
  `Source_eHeater_status` (Zuheizer/electrical heater status)
- `heatingCircuits.hc1_overallStatus` - heating circuit status (e.g. `heating_auto`)
- `heatingCircuits.hc1_currentRoomSetpoint` - heating circuit room setpoint
- `notifications` / `notifications.count` - error messages and their count
- `energy.used.{today,month}.{heatpump,eheater}` and `energy.used.overall.{heatpump,eheater,total}` - consumed energy (kWh)
- `energy.created.{today,month,overall}.{heatpump,environment}` - generated heat (kWh)
- `signals.<signalId>` - appliance-specific signals discovered via `/signals`

## Configuration

The settings are split into two tabs: **Connection** (host, ports, certificate
handling, credentials and request timeout) and **Data** (paths, signals and
energy monitoring).

For authentication, you can provide either:
1. Login and password from the gateway label - you'll need to press WLAN and Wireless buttons simultaneously for 1 second within 5 minutes of first connection to prove physical proximity
2. Pre-generated access token - can be obtained via the gateway's API on port 9442

The appliance-specific signals are polled on a slower, separately
configurable interval whenever a **Signals filter** is set. The filter is a
regular expression matched against the full signal path, e.g.
`^/signals/(SC|HC1)`; leave it empty to poll no signals, or use `.*` to read
them all.

Both polling intervals are entered in **seconds**. By default, the core values
are read every 60 s and the appliance signals every 300 s (5 minutes). The
request timeout is in milliseconds.

The **Paths to poll** textarea (in the **Data** tab) lists the eagerly
polled resources, one **path per line**. The state id is derived automatically:
the first path segment becomes the channel, all following segments are
flattened with underscores, e.g. `/system/sensors/temperatures/outdoor_t1` →
`system.sensors_temperatures_outdoor_t1`. Adjust this list to what your
gateway actually provides - e.g. if `/heatSources/dhw/cylinderTemperature`
returns 404 on your system, remove it or replace it with
`/heatSources/dhw/cylinderUpperTemp`. Lines starting with `#` are ignored.
On instances updated from earlier versions (where the field did not exist yet)
the built-in default list keeps being used until you open and save the
settings; an explicitly empty field polls no core paths at all.

The **Accept self-signed gateway certificates** option (enabled by default)
disables HTTPS certificate verification, which is required because the MX400
ships with its own self-signed certificate.

### Discovery and testing

The gateway advertises itself on the local network through the mDNS service
`_hvac-open-api._tcp`. When **Use mDNS** is enabled, the adapter looks up the
gateway on every start and uses the discovered address, so the host stays
correct even when the DHCP address changes. When it is disabled (or nothing is
found), the **Gateway host or IP** field is used as-is.

The **Test connection** button in the **Connection** tab validates the values
currently entered in the form - even before saving them. It resolves the host
via mDNS when enabled, requests an access token if no token is given, and reads
a gateway resource. On success a message is shown; if mDNS found the gateway at
a different address, that address is written into the **Gateway host or IP**
field and you are asked to save the configuration.

## Energy monitoring

With **Enable energy monitoring** (on by default) the adapter reads the energy
monitor (`emon`) resources and creates this tree (all values in kWh):

```
energy
├── used
│   ├── today
│   │   └── heatpump   └── eheater
│   ├── month
│   │   └── heatpump   └── eheater
│   └── overall
│       └── heatpump   └── eheater
└── created
    ├── today
    │   └── heatpump   └── environment
    ├── month
    │   └── heatpump   └── environment
    └── overall
        └── heatpump   └── environment
```

- **overall** comes from `/heatSources/emon/totalConsumption`: `compressor`
  (heat pump), `eheater`, `electricity` (total) and `outputProduced` (generated
  heat). Only the overall total electricity is available; the gateway provides
  no daily/monthly electricity recording.
- **today** and **month** come from the recordings API
  (`/recordings/heatSources/emon/total/{compressor,eheater,outputProduced}`),
  using the last daily (`P1D`) and the monthly (`P1M`) sample.
- The **Energy interval** (default 3600 s = 1 hour) controls how often these are
  read; energy requests are heavier, so a slow cadence is recommended.
- The **created** (produced) heat is split into **heatpump** and **environment**.
  The gateway has no dedicated environmental-energy value, so these are derived
  from the standard heat-pump energy balance:
  `created.heatpump` = compressor input (`compressor`; `outputProduced` is the
  total produced heat), and `created.environment` = produced heat − compressor
  input − electric-heater input (the free heat taken from the environment).

If your gateway does not serve the energy endpoints, the error log will name
them (e.g. `Energy poll failed with 404: ...`); disable **Enable energy
monitoring** if the whole tier is unavailable.

## Error logging

Connection problems are reported in the adapter's **error log** with one entry
per failing endpoint, following the schema
`<Core/Signal> poll failed with <Error Code>: <Path> returns <Error message>`:

- `Core poll failed with 404: /heatingCircuits/hc1/overallStatus returns Not Found`
- `Signal poll failed with 404: /signals/SC1_flowTemp returns Not Found`

For HTTP errors the code is the HTTP status (e.g. `404`) and the message is the
gateway's error text (falling back to the HTTP status text like `Not Found`).
If the gateway cannot be reached (HTTPS certificate rejected, host unreachable,
or timeout) the code is the transport error (e.g. `ECONNREFUSED`,
`CERT_HAS_EXPIRED`) and `info.connection` is set to `false`:
- `Core poll failed with ECONNREFUSED: /heatSources/actualSupplyTemperature returns connect ECONNREFUSED 192.168.1.10:9443`

The energy tier uses the same schema (`Energy` tier):

- `Energy poll failed with 404: /recordings/heatSources/emon/total/compressor?sampleRate=all&startDate=2026-10-01&endDate=2026-10-12 returns Not Found`

Per-request detail (values read, individual fetch outcomes) stays at debug
level.

## License

MIT
