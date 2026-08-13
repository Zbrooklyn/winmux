# Security Policy

## Supported versions

WinMux is early software. Security fixes land on the latest `0.1.x` release. Older builds are not
maintained, so please update before reporting.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Instead, use GitHub's private reporting:
go to the repository's **Security** tab and choose **Report a vulnerability**. That reaches the
maintainers privately.

When you report, include the version, your platform, the steps to reproduce, and the impact you
observed. We will confirm receipt, investigate, and keep you updated on a fix.

## Good to know about WinMux's security model

- The installer is unsigned, so Windows SmartScreen warns on first run. That is expected for this
  build, not a compromise.
- Phone access is off by default. When enabled, it rides your private Tailscale network rather than
  a public port, and a device is only trusted after it scans the pairing QR once. Forgetting a
  device rotates the key so an old link stops working.
- The `winmux` CLI and the projects API are reachable only at the local machine (`127.0.0.1`),
  never over the phone link.
