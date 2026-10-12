# Changelog

## Unreleased
- Added a **Use mDNS** gateway discovery: the adapter looks up the gateway via
  the `_hvac-open-api._tcp` mDNS service (for example on startup) and uses the
  discovered address, and the new **Test connection** button in the Connection
  tab verifies the entered values, requests a token if needed and writes the
  discovered host into the "Gateway host or IP" field.
- Reorganised the adapter settings into **Connection** and **Data** tabs. The
  certificate option now sits right after the ports; "Core paths to poll" was
  renamed to **"Paths to poll"** (with a link to the documentation) and the
  paths, signals and energy sections are now labelled group headings.
- Added optional energy monitoring (on by default, new "Enable energy
  monitoring" checkbox and "Energy interval (s)" field, default 3600 s). It
  creates an `energy` tree with `used` (heat pump / electric heater, plus total
  electricity overall) and `created` (generated heat) values for today, this
  month and overall, all in kWh. Overall values come from
  `/heatSources/emon/totalConsumption`, the today/month values from the
  `/recordings/heatSources/emon/total/...` API.
  Generated heat is split into `heatpump` and `environment`; since the gateway
  has no environmental-energy value, it is derived from the heat-pump energy
  balance (`environment` = produced heat − compressor input − electric-heater
  input).
  The daily/monthly electricity recordings are not used (not available on the
  gateway), so there is no total electricity for today/this month.
- The core resource list is now editable in the adapter settings
  ("Core paths to poll", after the access token): one path per line, the
  state id is derived from the path automatically (first segment = channel,
  following segments flattened with underscores). Paths that return 404 (e.g.
  `/heatSources/dhw/cylinderTemperature`) can be removed or replaced (e.g.
  with `/heatSources/dhw/cylinderUpperTemp`).
- Defaults extended with the additional heater (Zuheizer) status
  (`/heatSources/Source/eHeater/status`), the heating circuit status
  (`/heatingCircuits/hc1/overallStatus`, e.g. `heating_auto`) and the room
  setpoint (`/heatingCircuits/hc1/currentRoomSetpoint`). If your heating
  circuit id differs, adjust the `/heatingCircuits/<id>/...` lines.
  `/heatSources/dhw/cylinderTemperature` is no longer included in the default
  list (it returns 404 on some systems); add it back if your gateway provides
  it.
- State ids of the core values are now derived from their paths (e.g.
  `system.outdoorTemperature` → `system.sensors_temperatures_outdoor_t1`,
  `heatsource.compressorPower` → `heatSources.compressor_powerElecActual`,
  `dhw.cylinderTemperature` → `heatSources.dhw_cylinderTemperature`).
  Objects created under the old names are not migrated automatically.
- Connection failures (HTTPS certificate not accepted, host unreachable,
  timeouts) and failing endpoints are now reported to the error log with one
  entry per failing endpoint, following the schema
  `<Core/Signal> poll failed with <Error Code>: <Path> returns <Error message>`.
  `info.connection` is set to `false` when the gateway cannot be reached.
- The "Certificate verification enabled/disabled" startup message is now
  logged at debug level instead of info.
- Polling intervals are now configured in seconds instead of milliseconds
  (core default 60 s, signals default 300 s). Re-save the adapter config once
  to pick up the new defaults.
- Replaced "Reject unauthorized certificates" with a clearer
  "Accept self-signed gateway certificates" option (enabled by default),
  required for the MX400's self-signed HTTPS certificate.

## 0.0.1 (2026-10-11)
- Initial release
