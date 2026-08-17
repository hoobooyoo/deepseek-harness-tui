#!/usr/bin/env python3
"""
deepcode X11 clipboard daemon — owns the CLIPBOARD selection for terminals
that ignore OSC 52 (GNOME Terminal / VTE) on sessions without xclip/xsel
(X11) or wl-copy (Wayland only).

The TUI spawns ONE daemon per session and writes `SET <base64>\n` lines to
its stdin; each SET re-owns the selection with the latest text. The daemon
serves paste requests (SelectionRequest) while it lives, so pasting into any
app works. It exits when stdin closes (the TUI quit) or after an idle safety
timeout.

Exit codes: 0 = clean exit, 2 = environment unusable (no Gdk / no display).
"""

import base64
import sys

try:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, GLib, Gtk
except Exception:  # noqa: BLE001 -- any import failure means "cannot help"
    sys.exit(2)

# If the TUI dies without closing stdin, do not linger forever.
IDLE_EXIT_SECONDS = 600


def main() -> int:
    display = Gdk.Display.get_default()
    if display is None:
        return 2

    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)

    def on_stdin(_source, _condition):
        line = sys.stdin.readline()
        if line == "":
            # stdin closed — the TUI quit (or crashed): release everything.
            Gtk.main_quit()
            return False
        line = line.strip()
        if line.startswith("SET "):
            try:
                text = base64.b64decode(line[4:]).decode("utf-8")
            except Exception:  # noqa: BLE001 -- malformed command: ignore
                text = ""
            if text != "":
                clipboard.set_text(text, -1)
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    GLib.timeout_add_seconds(IDLE_EXIT_SECONDS, Gtk.main_quit)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
