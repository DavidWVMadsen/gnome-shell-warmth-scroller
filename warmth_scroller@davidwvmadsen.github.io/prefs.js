import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODIFIER_KEYS = ['none', 'ctrl', 'alt', 'shift', 'super'];

export default class WarmthScrollerExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Warmth Scroller',
            description: 'Scroll on the top bar to change the screen color temperature with Night Light. Neutral is 6500 K; scrolling back to neutral restores your own Night Light settings.',
        });
        page.add(group);

        // Required modifier key
        const modifierRow = new Adw.ComboRow({
            title: 'Required modifier key',
            subtitle: 'Only change the color temperature on scroll while this key is held',
            model: Gtk.StringList.new(['None', 'Ctrl', 'Alt', 'Shift', 'Super']),
            selected: Math.max(0, MODIFIER_KEYS.indexOf(settings.get_string('modifier-key'))),
        });
        modifierRow.connect('notify::selected', () => {
            settings.set_string('modifier-key', MODIFIER_KEYS[modifierRow.selected]);
        });
        const modifierId = settings.connect('changed::modifier-key', () => {
            modifierRow.selected = Math.max(0, MODIFIER_KEYS.indexOf(settings.get_string('modifier-key')));
        });
        window.connect('close-request', () => {
            settings.disconnect(modifierId);
            return false;
        });
        group.add(modifierRow);

        // Invert scroll direction
        const invertRow = new Adw.ActionRow({
            title: 'Invert scroll direction',
            subtitle: 'By default scrolling up makes the screen warmer',
        });
        const invertSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
        settings.bind('invert-scroll', invertSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        invertRow.add_suffix(invertSwitch);
        invertRow.activatable_widget = invertSwitch;
        group.add(invertRow);

        // Step
        const stepRow = new Adw.SpinRow({
            title: 'Step (K)',
            subtitle: 'Color temperature change per scroll tick, in Kelvin',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 1000, step_increment: 50, page_increment: 250}),
            digits: 0,
        });
        settings.bind('step', stepRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(stepRow);

        // Maximum warmth (minimum temperature)
        const minRow = new Adw.SpinRow({
            title: 'Maximum warmth (K)',
            subtitle: 'Warmest color temperature scrolling can reach, in Kelvin (lower is warmer)',
            adjustment: new Gtk.Adjustment({lower: 1000, upper: 6000, step_increment: 100, page_increment: 500}),
            digits: 0,
        });
        settings.bind('min-temperature', minRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(minRow);

        window.add(page);
    }
}
