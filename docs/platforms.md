# Platform execution

Polymux uses Playwright for web flows and Appium for native flows. The
same compiled flow contract is checked against the selected driver before a
session starts, so unsupported steps fail early instead of being skipped.

## Web

Install all browser engines once:

```bash
npx playwright install chromium firefox webkit
```

Select an engine, optional Playwright device profile, and video recording:

```bash
polymux run checkout -b webkit -d "iPhone 13" -v
```

Web `request` steps use the browser context's request client, including cookies
created by the page. Route mocks are deterministic and remain active until an
`unmock` step. Image targets use local PNG template matching. Web multi-touch is
available in Chromium; all three engines support the remaining web capability
surface.

## Native

Install Appium 3, then ask Polymux to install every compatible platform driver
on the local Appium host:

```bash
npm install --global appium
polymux driver install --all
polymux doctor
```

Use `polymux driver install ios`, `android`, `macos`, or `windows` to install
one platform at a time. The matching `uninstall` commands remove drivers, and
`polymux doctor` always remains read-only.

Native image targeting additionally requires the Appium images plugin:

```bash
appium plugin install images
appium --use-plugins=images
```

The official Windows driver still relies on Microsoft's unmaintained
WinAppDriver; NovaWindows is a newer community drop-in replacement:

```bash
appium driver install --source=npm appium-novawindows-driver
```

Select it with `-C '{"appium:automationName":"NovaWindows"}'`.

Linux uses Polymux's direct AT-SPI backend by default and does not require
Appium. Install `python3`, `python3-gi`, `gir1.2-atspi-2.0`, and
`gir1.2-gtk-3.0`, then run Polymux inside the active graphical desktop session.
Passing `--appium-url` explicitly selects the legacy community Appium backend.

For a headless Linux host, provide an isolated display and accessibility bus:

```bash
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x720x24' polymux run -p linux
```

`polymux doctor` rejects the unusable 320×200 fallback display commonly exposed
when a Linux machine has no monitor attached and points to the headless setup.

Run a native flow against a local or remote server:

```bash
polymux run checkout \
  -p ios \
  -a http://127.0.0.1:4723 \
  -C '{"appium:deviceName":"iPhone 16 Pro"}' \
  -v
```

Discover hardware and simulators already authorized on the local machine:

```bash
polymux devices
polymux devices --platform ios --json
```

Select a discovered target without manually writing its Appium UDID:

```bash
polymux run checkout -p ios --target 00008120-...
```

Polymux reads iOS devices and simulators through Xcode and Android devices and
emulators through ADB. It cannot authorize hardware: iOS still requires trust,
Developer Mode, and Xcode signing; Android still requires USB debugging
approval. `--target` is local-only. Hardware attached to a remote Appium host
must still be selected through `--capabilities`.

`-C, --capabilities` passes a JSON object into Appium's `alwaysMatch` session
capabilities. A flow's `launch.app` maps to the driver's app path, bundle
ID, package, or app name capability; explicit CLI capabilities take precedence.
`-v, --video` uses the selected Appium driver's screen-recording commands.

| Polymux platform | Appium automation name | Maintenance |
| --- | --- | --- |
| `ios`, `ipados` | XCUITest | Appium team |
| `android` | UiAutomator2 | Appium team |
| `macos` | Mac2 | Appium team |
| `windows` | Windows | Appium team |
| `linux` | Direct AT-SPI | Built in |

## Capability boundaries

| Capability | Web | Native |
| --- | --- | --- |
| Launch, input, selection, keyboard | Yes | Yes |
| Deterministic element focus | Yes | No portable native equivalent |
| Navigation and deep links | Yes | Official mobile and desktop drivers |
| Pointer, scroll, swipe, drag | Yes | W3C actions or direct AT-SPI on Linux |
| Multi-touch | Chromium | Yes, when the platform driver supports W3C multi-actions |
| Accessibility, ID, text, role locators | Yes | Yes |
| Image targeting | Yes | Yes, with the Appium images plugin |
| Screenshots, visual baselines, stable-frame waits | Yes | Yes |
| Video | Yes | iOS, iPadOS, Android, and macOS when host prerequisites are met |
| HTTP requests | Browser-authenticated | Explicit native request headers |
| Network route mocks | Yes | No generic native equivalent |
| Controlled browser clock | Yes | No generic native equivalent |
| Platform-specific commands | No | `platform` steps map to `mobile:` Appium commands |

Native HTTP requests deliberately do not claim access to private app cookies or
tokens. Supply authentication headers in the flow. Network interception and
clock control remain web-only because native operating systems do not expose a
portable equivalent; a platform-specific Appium command can be used when a
particular driver provides one.

Run `polymux doctor` to check the project, all three browser engines, and the
default Appium endpoint. Use `polymux doctor -a <url>` for another server.
