/*
 * Per-application volume mixer QuickSettings indicator.
 * Provides individual volume control and output routing per app stream.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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

const AppStreamSlider = GObject.registerClass(
class AppStreamSlider extends PopupMenu.PopupBaseMenuItem {
    _init(stream, gettext) {
        super._init({reactive: false});
        this._stream = stream;
        this._ = gettext;
        this._destroyed = false;
        this._sinkInputIndex = stream.get_index();

        let box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });
        this.add_child(box);

        // Header row: icon + name + output (3-dot) button
        let headerBox = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
        box.add_child(headerBox);

        let gicon = null;
        let appId = stream.get_application_id();
        if (appId) {
            try {
                let appInfo = Gio.DesktopAppInfo.new(appId);
                if (appInfo)
                    gicon = appInfo.get_icon();
            } catch (e) {
                // No matching .desktop file for this app id — fall through
                // to the generic icon-name fallback below.
            }
        }
        if (gicon) {
            this._icon = new St.Icon({
                gicon,
                style_class: 'popup-menu-icon',
            });
            this._hasRealIcon = true;
        } else {
            let iconName = stream.get_icon_name();
            if (!iconName || iconName === '')
                iconName = 'application-x-executable-symbolic';
            this._icon = new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
            });
            this._hasRealIcon = false;
        }
        headerBox.add_child(this._icon);

        let label = stream.get_name() || stream.get_description() || 'Unknown';

        this._label = new St.Label({
            text: label,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(this._label);

        // Output (3-dot) button — opens a popup listing every sink, with
        // the currently-active one checked. Replaces the old always-visible
        // "Output: <name>" row, and fetches fresh state on every open, so
        // it never goes stale the way the old label-based approach did.
        this._outputButton = new St.Button({
            style_class: 'app-output-menu-button',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'view-more-symbolic',
                icon_size: 16,
            }),
        });
        headerBox.add_child(this._outputButton);

        this._outputMenu = new PopupMenu.PopupMenu(this._outputButton, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(this._outputMenu.actor);
        this._outputMenu.actor.hide();

        this._outputButtonClickedId = this._outputButton.connect('clicked', () => {
            this._populateOutputMenu();
            this._outputMenu.toggle();
        });

        // Slider row: mute button + slider + percentage
        let sliderBox = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
        box.add_child(sliderBox);

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
        this._slider.accessible_name = label;
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

        // Some apps (Discord's WebRTC engine among them) report an internal
        // component name instead of the app itself, and not every app sets
        // application.id for the DesktopAppInfo lookup above. Fall back to
        // application.process.binary, which more reliably reflects the
        // actual executable, once it's available.
        this._resolveFallbackInfo(stream.get_index(), label);
    }

    async _resolveFallbackInfo(sinkInputIndex, originalLabel) {
        let info = await Port.getSinkInputInfo();
        if (this._destroyed)
            return;
        let entry = info[String(sinkInputIndex)];
        if (!entry || !entry.binary)
            return;
        let binary = entry.binary;

        // Icon: only try this if the DesktopAppInfo lookup via application.id
        // already failed and we're still showing the generic fallback icon.
        if (!this._hasRealIcon) {
            try {
                let appInfo = Gio.DesktopAppInfo.new(`${binary.toLowerCase()}.desktop`);
                if (appInfo) {
                    let gicon = appInfo.get_icon();
                    if (gicon) {
                        this._icon.gicon = gicon;
                        this._hasRealIcon = true;
                    }
                }
            } catch (e) {
                // No matching .desktop file for this binary name either —
                // keep the generic fallback icon already showing.
            }
        }

        // Label: only override when the stream's self-reported name looks
        // like an internal component rather than the app itself.
        if (originalLabel.toLowerCase().includes('webrtc')) {
            let niceName = binary.charAt(0).toUpperCase() + binary.slice(1);
            this._label.text = niceName;
            this._slider.accessible_name = niceName;
        }

        // Firefox tab title: only Firefox reliably exposes this, and only
        // via PipeWire's native graph (pactl's view is unreliable/stale for
        // this specific field), so this is a separate, targeted lookup.
        // Joined via sinkInputIndex, which is confirmed identical to
        // pw-dump's object.serial — precise per-stream, so this correctly
        // distinguishes any number of simultaneous tabs, not just one.
        if (binary.toLowerCase() === 'firefox') {
            let titles = await Port.getFirefoxLiveTitles();
            if (this._destroyed)
                return;
            let title = titles[String(sinkInputIndex)];
            if (title && title.length > 50)
                title = `${title.slice(0, 49)}…`;
            // Fall back to a clean app name rather than leaving whatever
            // generic text (e.g. "AudioStream") the stream self-reported.
            let finalLabel = title || 'Firefox';
            this._label.text = finalLabel;
            this._slider.accessible_name = finalLabel;
        }
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
        // change_is_muted() is the canonical Gvc method (used by GNOME
        // Shell's own volume.js), but fall back to a direct property set
        // if it's ever unavailable, so muting still works either way.
        try {
            this._stream.change_is_muted(newMuted);
        } catch (e) {
            this._stream.is_muted = newMuted;
        }
        // change_is_muted() should trigger notify::is-muted on its own,
        // but update immediately too so the icon never looks unresponsive.
        this._updateMuteIcon();
    }

    async _populateOutputMenu() {
        this._outputMenu.removeAll();
        let [sinks, info] = await Promise.all([
            Port.getSinks(),
            Port.getSinkInputInfo(),
        ]);
        if (this._destroyed)
            return;
        let entry = info[String(this._sinkInputIndex)];
        let currentSinkId = entry ? entry.sinkId : undefined;
        for (let sink of sinks) {
            if (sink.name === undefined)
                continue;
            let item = new PopupMenu.PopupMenuItem(sink.name);
            if (currentSinkId !== undefined && String(sink.id) === String(currentSinkId))
                item.setOrnament(PopupMenu.Ornament.CHECK);
            item.connect('activate', () => this._moveSinkInput(sink));
            this._outputMenu.addMenuItem(item);
        }
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
                    if (!p.get_successful())
                        console.error(`SDC: pactl move-sink-input exited ${p.get_exit_status()}`);
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
        if (this._outputButtonClickedId) {
            this._outputButton.disconnect(this._outputButtonClickedId);
            this._outputButtonClickedId = null;
        }
        if (this._muteButtonClickedId) {
            this._muteButton.disconnect(this._muteButtonClickedId);
            this._muteButtonClickedId = null;
        }
        if (this._outputMenu) {
            this._outputMenu.destroy();
            this._outputMenu = null;
        }
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
        this._appStreams = {};

        this._streamAddedId = this._control.connect('stream-added',
            this._streamAdded.bind(this));
        this._streamRemovedId = this._control.connect('stream-removed',
            this._streamRemoved.bind(this));

        // Build initial stream list
        for (let stream of this._control.get_streams())
            this._streamAdded(this._control, stream.get_id());

        this._updateVisibility();
    }

    _streamAdded(control, id) {
        if (id in this._appStreams)
            return;

        let stream = control.lookup_stream_id(id);
        if (!stream || stream.is_event_stream || !(stream instanceof Gvc.MixerSinkInput))
            return;

        // Volume slider + output routing, combined into a single item
        let sliderItem = new AppStreamSlider(stream, this._);
        this._toggle.menu.addMenuItem(sliderItem);
        this._appStreams[id] = sliderItem;

        // Separator
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this._toggle.menu.addMenuItem(separator);
        // Store separator reference for cleanup
        sliderItem._separator = separator;

        this._updateVisibility();
    }

    _streamRemoved(_control, id) {
        if (id in this._appStreams) {
            let sliderItem = this._appStreams[id];
            if (sliderItem._separator)
                sliderItem._separator.destroy();
            sliderItem.destroy();
            delete this._appStreams[id];
        }
        this._updateVisibility();
    }

    _updateVisibility() {
        this._toggle.visible = Object.keys(this._appStreams).length > 0;
    }

    destroy() {
        if (this._streamAddedId) {
            this._control.disconnect(this._streamAddedId);
            this._streamAddedId = null;
        }
        if (this._streamRemovedId) {
            this._control.disconnect(this._streamRemovedId);
            this._streamRemovedId = null;
        }

        Object.keys(this._appStreams).forEach(id => {
            let item = this._appStreams[id];
            if (item._separator)
                item._separator.destroy();
            item.destroy();
        });
        this._appStreams = {};

        this._toggle?.destroy();
        super.destroy();
    }
});
