import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Config from "resource:///org/gnome/shell/misc/config.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

// Maps the "modifier-key" setting to the Clutter modifier mask(s) that must be held.
const ModifierMasks = {
  none: 0,
  ctrl: Clutter.ModifierType.CONTROL_MASK,
  alt: Clutter.ModifierType.MOD1_MASK,
  shift: Clutter.ModifierType.SHIFT_MASK,
  super: Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK,
};

const [SHELL_MAJOR] = Config.PACKAGE_VERSION.split(".").map(Number);
const TAG = "[warmth-scroller]";

const NEUTRAL = 6500; // Kelvin, RGB [1, 1, 1] in gnome-settings-daemon

const COLOR_SCHEMA = "org.gnome.settings-daemon.plugins.color";
const COLOR_BUS_NAME = "org.gnome.SettingsDaemon.Color";
const COLOR_OBJECT_PATH = "/org/gnome/SettingsDaemon/Color";
const COLOR_IFACE = "org.gnome.SettingsDaemon.Color";

/*
 * How Night Light is driven:
 *
 * gnome-settings-daemon only applies night-light-temperature while Night Light
 * is enabled AND its schedule says it is night. When the user first scrolls
 * away from neutral, the user's own Night Light settings (enabled, schedule,
 * temperature) are saved in this extension's settings, and Night Light is then
 * set to a manual schedule with from == to (0:00 -> 0:00), which
 * gnome-settings-daemon treats as a full 24 h period, i.e. "always on".
 *
 * When the temperature is scrolled back to neutral (6500 K), or the extension
 * is disabled, the saved settings are written back. If the user's own schedule
 * is active at that moment (it is night), "disabled until tomorrow" is set so
 * the screen really goes back to neutral instead of to the user's Night Light
 * temperature; gnome-settings-daemon clears that flag at the next sunrise /
 * schedule end.
 */
export default class WarmthScrollerExtension extends Extension {
  enable() {
    this.settings = this.getSettings();
    this._color = new Gio.Settings({ schema_id: COLOR_SCHEMA });
    this._smooth_acc = 0;
    this._neutralCheckId = 0;
    this._applying = false;

    const setStep = () => {
      this.step = this.settings.get_int("step");
    };
    const setDirection = () => {
      this.full_bar_warm = this.settings.get_boolean("full-bar-is-warm");
    };
    const setModifier = () => {
      this.modifier_mask = ModifierMasks[this.settings.get_string("modifier-key")] ?? 0;
    };
    const setMinimum = () => {
      this.min_temp = Math.clamp(this.settings.get_int("min-temperature"), 1000, 6000);
      if (this._overriding() && this._color.get_uint("night-light-temperature") < this.min_temp)
        this._color.set_uint("night-light-temperature", this.min_temp);
    };
    setStep();
    setDirection();
    setModifier();
    this.min_temp = Math.clamp(this.settings.get_int("min-temperature"), 1000, 6000);

    this._settingsIds = [
      this.settings.connect("changed::step", setStep),
      this.settings.connect("changed::full-bar-is-warm", setDirection),
      this.settings.connect("changed::modifier-key", setModifier),
      this.settings.connect("changed::min-temperature", setMinimum),
    ];

    // Saved state from a previous session whose override was changed by the
    // user in the meantime (e.g. in Settings) is stale: forget it.
    if (this._overriding() && !this._override_intact()) this.settings.set_boolean("saved-state-valid", false);

    this._colorIds = [
      "night-light-enabled",
      "night-light-schedule-automatic",
      "night-light-schedule-from",
      "night-light-schedule-to",
    ].map((key) => this._color.connect(`changed::${key}`, () => this._on_color_changed(key)));

    // Read-only use of the NightLightActive property, and setting
    // DisabledUntilTomorrow, of gnome-settings-daemon's color plugin.
    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;
    this._proxy = null;
    Gio.DBusProxy.new(
      Gio.DBus.session,
      Gio.DBusProxyFlags.DO_NOT_AUTO_START,
      null,
      COLOR_BUS_NAME,
      COLOR_OBJECT_PATH,
      COLOR_IFACE,
      cancellable,
      (_obj, res) => {
        try {
          const proxy = Gio.DBusProxy.new_finish(res);
          if (!cancellable.is_cancelled()) this._proxy = proxy;
        } catch (e) {
          if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.warn(`${TAG} could not connect to ${COLOR_BUS_NAME}: ${e.message}`);
        }
      },
    );

    this.scroll_binding = Main.panel.connect("scroll-event", this._handle_scroll.bind(this));
  }

  /*
   * Session modes: this extension also runs in the "unlock-dialog" session
   * mode, so that locking the screen does not call disable(), which would
   * restore the user's Night Light settings and reset the warmth every time
   * the screen locks. Scrolling is ignored while the screen is locked (see
   * _handle_scroll()).
   */
  disable() {
    if (this.scroll_binding) Main.panel.disconnect(this.scroll_binding);
    this.scroll_binding = null;

    if (this._neutralCheckId) GLib.source_remove(this._neutralCheckId);
    this._neutralCheckId = 0;

    this._colorIds?.forEach((id) => this._color.disconnect(id));
    this._colorIds = null;

    // Give the user's own Night Light settings back.
    if (this._overriding()) this._restore({ keepEnabled: false });

    this._cancellable?.cancel();
    this._cancellable = null;
    this._proxy = null;

    this._settingsIds?.forEach((id) => this.settings.disconnect(id));
    this._settingsIds = null;
    this._color = null;
    this.settings = null;
  }

  _overriding() {
    return this.settings.get_boolean("saved-state-valid");
  }

  // Whether Night Light still has the "always on" settings written by _take_over().
  _override_intact() {
    const c = this._color;
    return (
      c.get_boolean("night-light-enabled") &&
      !c.get_boolean("night-light-schedule-automatic") &&
      c.get_double("night-light-schedule-from") === 0 &&
      c.get_double("night-light-schedule-to") === 0
    );
  }

  _night_light_active() {
    const v = this._proxy?.get_cached_property("NightLightActive");
    return v ? v.unpack() : false;
  }

  _set_disabled_until_tomorrow(value) {
    if (!this._proxy) return;
    this._proxy.call(
      "org.freedesktop.DBus.Properties.Set",
      new GLib.Variant("(ssv)", [COLOR_IFACE, "DisabledUntilTomorrow", GLib.Variant.new_boolean(value)]),
      Gio.DBusCallFlags.NONE,
      -1,
      this._cancellable,
      (proxy, res) => {
        try {
          proxy.call_finish(res);
        } catch (e) {
          if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.warn(`${TAG} could not set DisabledUntilTomorrow: ${e.message}`);
        }
      },
    );
  }

  // The temperature currently shown on screen, as far as this extension is concerned.
  _current_temperature() {
    if (this._overriding()) return this._color.get_uint("night-light-temperature");
    // Not overriding: continue from the user's own Night Light if it is warming the screen now.
    const disabled = this._proxy?.get_cached_property("DisabledUntilTomorrow")?.unpack() ?? false;
    if (this._color.get_boolean("night-light-enabled") && this._night_light_active() && !disabled)
      return Math.min(this._color.get_uint("night-light-temperature"), NEUTRAL);
    return NEUTRAL;
  }

  _take_over() {
    const c = this._color;
    const s = this.settings;
    s.set_boolean("saved-enabled", c.get_boolean("night-light-enabled"));
    s.set_boolean("saved-schedule-automatic", c.get_boolean("night-light-schedule-automatic"));
    s.set_double("saved-schedule-from", c.get_double("night-light-schedule-from"));
    s.set_double("saved-schedule-to", c.get_double("night-light-schedule-to"));
    s.set_uint("saved-temperature", c.get_uint("night-light-temperature"));
    s.set_boolean("saved-active", c.get_boolean("night-light-enabled") && this._night_light_active());
    s.set_boolean("saved-state-valid", true);

    // from == to is a full 24 h period for gnome-settings-daemon: always on.
    c.set_double("night-light-schedule-from", 0);
    c.set_double("night-light-schedule-to", 0);
    c.set_boolean("night-light-schedule-automatic", false);
    if (!c.get_boolean("night-light-enabled")) c.set_boolean("night-light-enabled", true);
    this._set_disabled_until_tomorrow(false);
  }

  // Write the saved Night Light settings back. With keepEnabled, the current
  // night-light-enabled value is kept (used when the user switched Night Light
  // off themselves).
  _restore({ keepEnabled }) {
    const c = this._color;
    const s = this.settings;
    s.set_boolean("saved-state-valid", false);
    const enabled = keepEnabled ? c.get_boolean("night-light-enabled") : s.get_boolean("saved-enabled");
    // Switch off first so no intermediate schedule is applied.
    if (!enabled) c.set_boolean("night-light-enabled", false);
    c.set_boolean("night-light-schedule-automatic", s.get_boolean("saved-schedule-automatic"));
    c.set_double("night-light-schedule-from", s.get_double("saved-schedule-from"));
    c.set_double("night-light-schedule-to", s.get_double("saved-schedule-to"));
    c.set_uint("night-light-temperature", s.get_uint("saved-temperature"));
    if (enabled) c.set_boolean("night-light-enabled", true);
  }

  _on_color_changed(key) {
    if (this._applying || !this._overriding() || this._override_intact()) return;
    // The user changed Night Light outside of this extension while it was
    // overridden: stop overriding and respect their change.
    if (key === "night-light-enabled") {
      this._applying = true;
      try {
        this._restore({ keepEnabled: true });
      } finally {
        this._applying = false;
      }
    } else {
      // A new schedule was chosen: keep it, only put the temperature back.
      this.settings.set_boolean("saved-state-valid", false);
      this._color.set_uint("night-light-temperature", this.settings.get_uint("saved-temperature"));
    }
  }

  _set_temperature(temp) {
    this._applying = true;
    try {
      if (temp >= NEUTRAL) {
        if (this._overriding()) {
          const wasActive = this.settings.get_boolean("saved-active");
          this._restore({ keepEnabled: false });
          // If the user's own schedule turns out to be active right now,
          // "disable until tomorrow" so the screen actually goes neutral.
          if (wasActive) this._schedule_neutral_check();
        }
        return;
      }
      if (!this._overriding()) this._take_over();
      this._color.set_uint("night-light-temperature", temp);
    } finally {
      this._applying = false;
    }
  }

  _schedule_neutral_check() {
    if (this._neutralCheckId) GLib.source_remove(this._neutralCheckId);
    this._neutralCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      this._neutralCheckId = 0;
      if (!this._overriding() && this._color.get_boolean("night-light-enabled") && this._night_light_active())
        this._set_disabled_until_tomorrow(true);
      return GLib.SOURCE_REMOVE;
    });
  }

  _handle_scroll(_actor, event) {
    if (Main.sessionMode.isLocked) return Clutter.EVENT_PROPAGATE;
    if (this.modifier_mask && (event.get_state() & this.modifier_mask) === 0) {
      return Clutter.EVENT_PROPAGATE;
    }

    // +1 = up, -1 = down. Smooth scroll events (touchpads, hi-res wheels) are
    // accumulated so one wheel notch counts as one step.
    let dir = 0;
    switch (event.get_scroll_direction()) {
      case Clutter.ScrollDirection.UP:
        dir = 1;
        break;
      case Clutter.ScrollDirection.DOWN:
        dir = -1;
        break;
      case Clutter.ScrollDirection.SMOOTH: {
        const [, dy] = event.get_scroll_delta();
        this._smooth_acc -= dy;
        if (Math.abs(this._smooth_acc) < 1) return Clutter.EVENT_STOP;
        dir = Math.sign(this._smooth_acc);
        this._smooth_acc = 0;
        break;
      }
      default:
        return Clutter.EVENT_PROPAGATE;
    }

    // The scroll direction follows the OSD bar: scrolling up fills the bar.
    // By default a full bar is neutral (6500 K), so scrolling up is cooler and
    // scrolling down is warmer. With "full-bar-is-warm", a full bar is the
    // warmest temperature and scrolling up is warmer.
    const warmer = this.full_bar_warm ? dir > 0 : dir < 0;
    const current = this._current_temperature();
    let temp;
    if (warmer) temp = current <= this.min_temp ? current : Math.max(current - this.step, this.min_temp);
    else temp = Math.min(current + this.step, NEUTRAL);

    try {
      if (temp !== current || (temp >= NEUTRAL && this._overriding())) this._set_temperature(temp);
      this._show_osd(temp);
    } catch (e) {
      console.warn(`${TAG} failed to set color temperature: ${e}`);
    }
    return Clutter.EVENT_STOP;
  }

  _show_osd(temp) {
    const span = NEUTRAL - this.min_temp;
    const warmth = span > 0 ? Math.clamp((NEUTRAL - temp) / span, 0, 1) : 0;
    // Default: full bar = neutral, empty bar = maximum warmth.
    const level = this.full_bar_warm ? warmth : 1 - warmth;
    const icon = Gio.Icon.new_for_string("night-light-symbolic");
    const label = `${Math.round(temp)} K`;
    if (SHELL_MAJOR >= 49) {
      Main.osdWindowManager.showAll(icon, label, level);
    } else {
      Main.osdWindowManager.show(-1, icon, label, level);
    }
  }
}
