# Platform execution

Polymux validates a compiled flow against the selected driver before opening a
session. Unsupported capabilities must fail rather than be silently skipped.

## Driver map

| Platform | Backend |
| --- | --- |
| `web` | Playwright |
| `linux` | Direct AT-SPI by default |
| `ios`, `ipados` | Appium XCUITest |
| `android` | Appium UiAutomator2 |
| `macos` | Appium Mac2 |
| `windows` | Appium Windows or compatible replacement |

## Web

```bash
polymux run checkout --platform web --browser chromium
polymux run checkout --browser webkit --device "iPhone 13"
polymux run checkout --browser firefox --video
```

Supported browser engines are `chromium`, `firefox`, and `webkit`. Device
profiles are Playwright device names. Use `--headed` only when visible execution
is intentionally required.

Web supports browser-authenticated request steps, route mocks, controlled time,
and visual checks. Chromium additionally supports web multi-touch.

## Native with Appium

Discover authorized local targets:

```bash
polymux devices
polymux devices --platform ios --json
```

Select one:

```bash
polymux run checkout --platform ios --target 00008120-...
```

```bash
polymux run checkout \
  --platform ios \
  --appium-url http://127.0.0.1:4723 \
  --capabilities '{"appium:deviceName":"iPhone 16 Pro"}'
```

`--capabilities` is merged into Appium `alwaysMatch`; explicit CLI capabilities
take precedence over values inferred from the flow. A `launch.app` value maps
to the platform's app path, bundle ID, package, or app name.

`--target` translates a locally discovered iOS or Android identifier into
`appium:udid`. It does not pair or authorize hardware. Remote Appium inventory
is not discoverable through the standard protocol, so select remote hardware
with explicit capabilities.

Use platform-specific commands only when no portable step exists:

```yaml
steps:
  - platform:
      on: ios
      command: someDriverCommand
      args: { example: value }
```

The command maps to an Appium `mobile:` extension and intentionally reduces
portability.

## Linux

Linux uses the direct AT-SPI adapter when `--appium-url` is absent:

```bash
polymux run checkout --platform linux
```

It must run inside an active graphical desktop session with AT-SPI available.
On a headless host, provide an isolated display and accessibility bus:

```bash
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x720x24' \
  polymux run checkout --platform linux
```

Passing `--appium-url` for Linux explicitly selects the Appium backend.

## Diagnose setup

```bash
polymux doctor --json
polymux doctor --appium-url http://127.0.0.1:4723 --json
```

Run the doctor before changing a flow when the failure concerns browser
installation, display size, accessibility, Appium reachability, or another
execution prerequisite.

## Portability boundaries

- Network route mocks and clock control are web-only.
- Native HTTP requests do not inherit private application cookies or tokens;
  provide explicit headers.
- Image targeting on Appium requires its images plugin.
- Native focus has no portable deterministic equivalent.
- Video availability depends on the selected driver and host prerequisites.
