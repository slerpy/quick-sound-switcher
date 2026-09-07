/*
 * Per-application volume mixer QuickSettings indicator.
 * Provides individual volume control and output routing per app stream.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import * as Port from './portSettings.js';

const AppMixerToggle = GObject.registerClass(
class AppMixerToggle extends QuickSettings.QuickMenuToggle {
    _init(gettext) {
        super._init({
            title: gettext('App Mixer'),
            iconName: 'multimedia-volume-control-symbolic',
            toggleMode: false,
        });
    }
});

// Strips symbolic icon-name candidates so lookup prefers the full-color icon.
function preferFullColorIcon(gicon) {
    if (gicon instanceof Gio.ThemedIcon) {
        let names = gicon.get_names().filter(n => !n.includes('-symbolic'));
        if (names.length > 0)
            return Gio.ThemedIcon.new_from_names(names);
    }
    return gicon;
}

// Header row: icon + name + expand chevron -> output-device picker.
// Uses PopupSubMenuMenuItem (a standalone PopupMenu.PopupMenu breaks the
// QuickSettings modal grab -- don't go back to that).
const AppOutputSelector = GObject.registerClass(
class AppOutputSelector extends PopupMenu.PopupSubMenuMenuItem {
    _init(stream, gettext, topMenu) {
        super._init('', true);
        this._destroyed = false;
        this._stream = stream;
        this._ = gettext;
        this._topMenu = topMenu;
        this._sinkInputIndex = stream.get_index();
        // Tighten against the slider row below.
        this.style = 'padding-bottom: 2px;';

        this.icon.icon_size = 22;
        // Forces full-color rendering (some apps default to symbolic).
        this.icon.style = '-st-icon-style: regular;';

        let gicon = null;
        let appId = stream.get_application_id();
        if (appId) {
            try {
                let appInfo = Gio.DesktopAppInfo.new(appId);
                if (appInfo)
                    gicon = appInfo.get_icon();
            } catch (e) {
                // No matching .desktop file -- fall through to icon-name.
            }
        }
        if (gicon) {
            this.icon.gicon = preferFullColorIcon(gicon);
            this._hasRealIcon = true;
        } else {
            let iconName = stream.get_icon_name();
            if (!iconName || iconName === '')
                iconName = 'application-x-executable-symbolic';
            this.icon.icon_name = iconName;
            this._hasRealIcon = false;
        }

        let label = stream.get_name() || stream.get_description() || 'Unknown';
        this.label.text = label;

        // Fallback icon/label resolution via process.binary (async).
        this._resolveFallbackInfo(this._sinkInputIndex, label);
    }

    async _resolveFallbackInfo(sinkInputIndex, originalLabel) {
        let info = await Port.getSinkInputInfo();
        if (this._destroyed)
            return;
        let entry = info[String(sinkInputIndex)];
        if (!entry || !entry.binary)
            return;
        let binary = entry.binary;

        // Only needed if the application.id lookup above already failed.
        if (!this._hasRealIcon) {
            try {
                let appInfo = Gio.DesktopAppInfo.new(`${binary.toLowerCase()}.desktop`);
                if (appInfo) {
                    let gicon = appInfo.get_icon();
                    if (gicon) {
                        this.icon.gicon = preferFullColorIcon(gicon);
                        this._hasRealIcon = true;
                    }
                }
            } catch (e) {
                // Keep the generic fallback icon.
            }
        }

        // Discord's WebRTC engine reports itself instead of "Discord".
        if (originalLabel.toLowerCase().includes('webrtc')) {
            let niceName = binary.charAt(0).toUpperCase() + binary.slice(1);
            this.label.text = niceName;
            if (this.onLabelChanged)
                this.onLabelChanged(niceName);
        }

        // Firefox-only live tab title, via pw-dump (see portSettings.js).
        if (binary.toLowerCase() === 'firefox') {
            let titles = await Port.getFirefoxLiveTitles();
            if (this._destroyed)
                return;
            let title = titles[String(sinkInputIndex)];
            if (title && title.length > 50)
                title = `${title.slice(0, 49)}…`;
            let finalLabel = title || 'Firefox';
            this.label.text = finalLabel;
            if (this.onLabelChanged)
                this.onLabelChanged(finalLabel);
        }
    }

    updateSinks() {
        if (this._destroyed)
            return;
        this.menu.removeAll();
        Promise.all([
            Port.getSinks(),
            Port.getSinkInputInfo(),
        ]).then(([sinks, info]) => {
            if (this._destroyed)
                return;
            let entry = info[String(this._sinkInputIndex)];
            let currentSinkId = entry ? entry.sinkId : undefined;
            for (let sink of sinks) {
                if (sink.name === undefined)
                    continue;
                // activate:false stops selection from closing the whole
                // panel; button-press-event drives the actual click.
                let item = new PopupMenu.PopupMenuItem(sink.name, {activate: false});
                if (currentSinkId !== undefined && String(sink.id) === String(currentSinkId))
                    item.setOrnament(PopupMenu.Ornament.CHECK);
                item.reactive = true;
                item.connect('button-press-event', () => {
                    this._moveSinkInput(sink);
                    return Clutter.EVENT_STOP;
                });
                this.menu.addMenuItem(item);
            }
        }).catch(e => {
            console.error(`SDC: Failed to load sinks: ${e}`);
        });
    }

    _moveSinkInput(sink) {
        try {
            let proc = Gio.Subprocess.new(
                ['pactl', 'move-sink-input',
                    String(this._sinkInputIndex), String(sink.id)],
                Gio.SubprocessFlags.NONE);
            proc.wait_async(null, (p, res) => {
                try {
                    p.wait_finish(res);
                    if (p.get_successful()) {
                        // Small delay: pactl reports success before the
                        // routing change is actually queryable.
                        if (!this._destroyed) {
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                                if (!this._destroyed)
                                    this.updateSinks();
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    } else {
                        console.error(`SDC: pactl move-sink-input exited ${p.get_exit_status()}`);
                    }
                } catch (e) {
                    console.error(`SDC: Failed to move sink input: ${e}`);
                }
            });
        } catch (e) {
            console.error(`SDC: Failed to spawn pactl: ${e}`);
        }
    }

    destroy() {
        this._destroyed = true;
        super.destroy();
    }
});

// Slider row beneath each app header: mute button + slider + percentage.
const AppVolumeRow = GObject.registerClass(
class AppVolumeRow extends PopupMenu.PopupBaseMenuItem {
    _init(stream, gettext, headerItem) {
        super._init({reactive: false});
        this._stream = stream;
        this._ = gettext;
        this._destroyed = false;
        this._headerItem = headerItem;
        // Matches the header row's tightened bottom padding, so the two
        // rows read as one cohesive block.
        this.style = 'padding-top: 2px;';

        let sliderBox = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
        this.add_child(sliderBox);

        this._muteButton = new St.Button({
            style_class: 'app-mute-button',
            can_focus: true,
            child: new St.Icon({
                icon_name: this._getMuteIconName(),
                icon_size: 16,
            }),
        });
        sliderBox.add_child(this._muteButton);
        this._muteButtonClickedId = this._muteButton.connect('clicked', () => {
            this._toggleMute();
        });

        let vol = stream.volume / this._getMaxVolume();
        this._slider = new Slider.Slider(Math.min(vol, 1.0));
        this._slider.x_expand = true;
        this._slider.accessible_name = headerItem.label.text;
        sliderBox.add_child(this._slider);

        this._percentLabel = new St.Label({
            text: `${Math.round(Math.min(vol, 1.0) * 100)}%`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        sliderBox.add_child(this._percentLabel);

        this._sliderChangedId = this._slider.connect('notify::value', () => {
            let newVol = this._slider.value * this._getMaxVolume();
            this._stream.volume = newVol;
            this._stream.push_volume();
            this._percentLabel.text = `${Math.round(this._slider.value * 100)}%`;
        });

        this._streamChangedId = this._stream.connect('notify::volume', () => {
            this._updateSlider();
        });

        this._streamMutedId = this._stream.connect('notify::is-muted', () => {
            this._updateMuteIcon();
        });

        // Keep accessible name in sync with async label resolution.
        headerItem.onLabelChanged = newLabel => {
            this._slider.accessible_name = newLabel;
        };
    }

    _getMaxVolume() {
        return Volume.getMixerControl().get_vol_max_norm();
    }

    _updateSlider() {
        let vol = this._stream.volume / this._getMaxVolume();
        this._slider.block_signal_handler(this._sliderChangedId);
        this._slider.value = Math.min(vol, 1.0);
        this._slider.unblock_signal_handler(this._sliderChangedId);
        this._percentLabel.text = `${Math.round(Math.min(vol, 1.0) * 100)}%`;
    }

    _getMuteIconName() {
        return this._stream.is_muted
            ? 'audio-volume-muted-symbolic'
            : 'audio-volume-high-symbolic';
    }

    _updateMuteIcon() {
        this._muteButton.child.icon_name = this._getMuteIconName();
    }

    _toggleMute() {
        let newMuted = !this._stream.is_muted;
        try {
            this._stream.change_is_muted(newMuted);
        } catch (e) {
            this._stream.is_muted = newMuted;
        }
        this._updateMuteIcon();
    }

    destroy() {
        this._destroyed = true;
        if (this._sliderChangedId) {
            this._slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = null;
        }
        if (this._streamChangedId) {
            this._stream.disconnect(this._streamChangedId);
            this._streamChangedId = null;
        }
        if (this._streamMutedId) {
            this._stream.disconnect(this._streamMutedId);
            this._streamMutedId = null;
        }
        if (this._muteButtonClickedId) {
            this._muteButton.disconnect(this._muteButtonClickedId);
            this._muteButtonClickedId = null;
        }
        if (this._headerItem)
            this._headerItem.onLabelChanged = null;
        super.destroy();
    }
});

export const AppMixerIndicator = GObject.registerClass(
class AppMixerIndicator extends QuickSettings.SystemIndicator {
    _init(settings, gettext) {
        super._init();
        this._settings = settings;
        this._ = gettext;

        this._toggle = new AppMixerToggle(gettext);
        this._toggle.menu.setHeader(
            'multimedia-volume-control-symbolic',
            gettext('Application Volume'));
        this.quickSettingsItems.push(this._toggle);

        this._control = Volume.getMixerControl();
        this._appHeaders = {};
        this._appVolumeRows = {};

        this._streamAddedId = this._control.connect('stream-added',
            this._streamAdded.bind(this));
        this._streamRemovedId = this._control.connect('stream-removed',
            this._streamRemoved.bind(this));

        // Build initial stream list
        for (let stream of this._control.get_streams())
            this._streamAdded(this._control, stream.get_id());

        this._updateVisibility();

        // Refresh sink lists + checkmarks every time the menu opens.
        this._menuOpenId = this._toggle.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                Object.values(this._appHeaders).forEach(sel =>
                    sel.updateSinks());
            }
        });
    }

    _streamAdded(control, id) {
        if (id in this._appHeaders)
            return;

        let stream = control.lookup_stream_id(id);
        if (!stream || stream.is_event_stream || !(stream instanceof Gvc.MixerSinkInput))
            return;

        // Header row: icon + name + expand chevron (output picker)
        let headerItem = new AppOutputSelector(stream, this._, this._toggle.menu);
        this._toggle.menu.addMenuItem(headerItem);
        this._appHeaders[id] = headerItem;

        // Slider row: mute + slider + percentage
        let volumeRow = new AppVolumeRow(stream, this._, headerItem);
        this._toggle.menu.addMenuItem(volumeRow);
        this._appVolumeRows[id] = volumeRow;

        // Separator
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this._toggle.menu.addMenuItem(separator);
        headerItem._separator = separator;

        this._updateVisibility();
    }

    _streamRemoved(_control, id) {
        if (id in this._appHeaders) {
            let headerItem = this._appHeaders[id];
            if (headerItem._separator)
                headerItem._separator.destroy();
            headerItem.destroy();
            delete this._appHeaders[id];
        }
        if (id in this._appVolumeRows) {
            this._appVolumeRows[id].destroy();
            delete this._appVolumeRows[id];
        }
        this._updateVisibility();
    }

    _updateVisibility() {
        this._toggle.visible = Object.keys(this._appHeaders).length > 0;
    }

    destroy() {
        if (this._menuOpenId) {
            this._toggle.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
        if (this._streamAddedId) {
            this._control.disconnect(this._streamAddedId);
            this._streamAddedId = null;
        }
        if (this._streamRemovedId) {
            this._control.disconnect(this._streamRemovedId);
            this._streamRemovedId = null;
        }

        Object.keys(this._appHeaders).forEach(id => {
            let item = this._appHeaders[id];
            if (item._separator)
                item._separator.destroy();
            item.destroy();
        });
        this._appHeaders = {};

        Object.keys(this._appVolumeRows).forEach(id => {
            this._appVolumeRows[id].destroy();
        });
        this._appVolumeRows = {};

        this._toggle?.destroy();
        super.destroy();
    }
});
