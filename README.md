# Warmth Scroller for GNOME Shell

Hold a modifier key (Shift by default) and scroll on the GNOME top bar to make the screen warmer or cooler, with GNOME's standard on-screen display (Night Light icon, a bar that fills as the screen gets warmer, and the temperature in Kelvin).

It is a sibling of [Brightness Scroller](https://github.com/DavidWVMadsen/gnome-shell-brightness-scroller) and works on GNOME Shell 45–51.

## Settings

- **Required modifier key**: None, Ctrl, Alt, Shift (default) or Super.
- **Invert scroll direction**: by default scrolling up is warmer and scrolling down is cooler.
- **Step**: Kelvin per scroll tick (50–1000, default 250).
- **Maximum warmth**: the warmest temperature scrolling can reach (1000–6000 K, default 1700 K). Neutral is 6500 K.

## How it works

The extension drives GNOME's own Night Light (`org.gnome.settings-daemon.plugins.color`), so the color change is done by gnome-settings-daemon and Mutter, the same way the Night Light switch in Quick Settings does it.

Night Light only changes the screen while it is enabled and its schedule says it is night. So, the first time you scroll away from neutral, the extension:

1. saves your own Night Light settings (`night-light-enabled`, `night-light-schedule-automatic`, `night-light-schedule-from`, `night-light-schedule-to`, `night-light-temperature`) in its own settings;
2. switches Night Light to a manual schedule from 0:00 to 0:00, which gnome-settings-daemon treats as a full 24 hours ("always on"), enables it, and clears "disabled until tomorrow";
3. sets `night-light-temperature` on every scroll tick.

When you scroll back to neutral (6500 K), or disable the extension, your saved Night Light settings are written back. If your own Night Light schedule is active at that moment (it is night and you normally use Night Light), the extension also sets Night Light to "disabled until tomorrow", so the screen really goes back to neutral; GNOME clears that by itself at your next sunrise or schedule end.

If you change Night Light yourself while the extension is overriding it (for example you switch Night Light off in Quick Settings, or pick a new schedule in Settings), the extension stops overriding and keeps your change.

The extension also stays enabled on the lock screen (session mode `unlock-dialog`), only so the warmth you chose is not reset every time the screen locks. Scrolling is ignored while the screen is locked.

## Caveats

- While the extension is overriding Night Light, Settings → Displays → Night Light shows a manual schedule of 00:00–00:00 and your chosen temperature. Your own settings come back when you scroll to neutral or disable the extension.
- gnome-settings-daemon fades to each new temperature over a few seconds, so changes are smooth rather than instant.
- Night Light needs a display and driver that support gamma/color adjustment. If Night Light does not work on your system, this extension will not either.

## Credit

Derived from [Volume Scroller](https://github.com/francislavoie/gnome-shell-volume-scroller) by francislavoie (itself forked from trflynn89's original), via [Brightness Scroller](https://github.com/DavidWVMadsen/gnome-shell-brightness-scroller). Licensed under the same license, the GNU GPL v2 (see LICENSE).

## Installation from a zip

```bash
gnome-extensions install --force warmth_scroller@davidwvmadsen.github.io.shell-extension.zip
```

Log out and back in (Wayland) or restart the shell (X11), then:

```bash
gnome-extensions enable warmth_scroller@davidwvmadsen.github.io
```

## Manual installation from source

```bash
cp -r warmth_scroller@davidwvmadsen.github.io ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/warmth_scroller@davidwvmadsen.github.io/schemas/
```

Then log out and back in and enable it as above. (GNOME 44 and later compile the schemas themselves when installing from a zip, so the compiled schema is not shipped.)

## Building the zip

```bash
gnome-extensions pack --force warmth_scroller@davidwvmadsen.github.io
```

## Troubleshooting

```bash
gnome-extensions info warmth_scroller@davidwvmadsen.github.io   # State should be ACTIVE
journalctl -f -o cat /usr/bin/gnome-shell | grep warmth-scroller
gsettings list-recursively org.gnome.settings-daemon.plugins.color
```

The folder name must equal the UUID. On Wayland you have to log out and back in after installing.
